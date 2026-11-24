"""Daily loss window must be anchored with an explicit, verified broker UTC offset.

MT5 deal ``time`` is broker *server* time (DBG/most MT5 brokers: UTC+2/+3).
A silent default of 0 makes a deal booked at 00:30 server time (= 21:30 UTC
the previous day) count as "today", so yesterday's realized profit can offset
today's realized loss and hide a breach of the 3% daily limit.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

spec = importlib.util.spec_from_file_location("xauusd_mt5_direct_probe_dayoffset", SCRIPTS / "mt5-direct-probe.py")
engine = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = engine
spec.loader.exec_module(engine)

# 2026-11-24 10:00:00 UTC
NOW_UTC = 1795514400
DAY_START_UTC = 1795478400  # 2026-11-24 00:00:00 UTC
SERVER_OFFSET_H = 2.0       # broker server UTC+2


class _Broker:
    def __init__(self, deals):
        self._deals = deals

    def history_deals_get(self, *args):
        return list(self._deals)


def _account(balance=4000.0, equity=None):
    return SimpleNamespace(login=5201362, server="MOCK-DEMO", balance=balance,
                           equity=balance if equity is None else equity)


def _deal(utc_ts, profit, server_offset_h=SERVER_OFFSET_H, ticket=1):
    # MT5 reports deal.time in broker server time.
    return SimpleNamespace(ticket=ticket, time=int(utc_ts + server_offset_h * 3600), type=0,
                           entry=1, profit=profit, commission=0.0, swap=0.0, fee=0.0)


class DailyLossBrokerOffsetTest(unittest.TestCase):
    def setUp(self):
        self.rt = Path(tempfile.mkdtemp(prefix="v6-dayoffset-"))
        self.addCleanup(shutil.rmtree, self.rt, True)
        p = patch.object(engine, "DAILY_RISK_STATE_FILE", self.rt / "v6-daily-risk-state.json")
        p.start()
        self.addCleanup(p.stop)
        env = {k: v for k, v in os.environ.items() if k != engine.BROKER_UTC_OFFSET_ENV}
        e = patch.dict(os.environ, env, clear=True)
        e.start()
        self.addCleanup(e.stop)

    def _compute(self, deals, cfg, account=None):
        return engine.compute_and_persist_daily_loss_state(
            _Broker(deals), account or _account(), cfg, open_positions=[], now_utc=NOW_UTC)

    def test_missing_offset_fails_closed(self):
        res = self._compute([], {"maxDailyLossPercent": 3.0})
        self.assertFalse(res["ok"])
        self.assertIn("BROKER_UTC_OFFSET_UNVERIFIED", res["reason"])

    def test_invalid_offsets_fail_closed(self):
        for bad in (True, False, "2", None, float("nan"), float("inf"), 15.0, -13.0, 2.1):
            with self.subTest(bad=bad):
                res = self._compute([], {"maxDailyLossPercent": 3.0, "brokerUtcOffsetHours": bad})
                self.assertFalse(res["ok"])
                self.assertIn("BROKER_UTC_OFFSET_UNVERIFIED", res["reason"])

    def test_invalid_env_offsets_fail_closed(self):
        for bad in ("", "  ", "abc", "nan", "99", "2.1"):
            with self.subTest(bad=bad), patch.dict(os.environ, {engine.BROKER_UTC_OFFSET_ENV: bad}):
                res = self._compute([], {"maxDailyLossPercent": 3.0})
                self.assertFalse(res["ok"])

    def test_valid_offsets_accepted_including_half_and_quarter_hours(self):
        for good in (0, 0.0, 2, 3.0, -5.0, 5.5, 5.75, 14.0, -12.0):
            with self.subTest(good=good):
                res = self._compute([], {"maxDailyLossPercent": 3.0, "brokerUtcOffsetHours": good})
                self.assertTrue(res["ok"], res)
                self.assertEqual(res["brokerUtcOffsetHours"], float(good))

    def test_env_offset_used_when_cfg_absent(self):
        with patch.dict(os.environ, {engine.BROKER_UTC_OFFSET_ENV: "3"}):
            res = self._compute([], {"maxDailyLossPercent": 3.0})
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["brokerUtcOffsetHours"], 3.0)

    def test_yesterday_profit_cannot_hide_today_breach(self):
        # Yesterday 21:30 UTC (= 23:30 server): +200 profit. Today 02:00 UTC: -150 loss.
        deals = [
            _deal(DAY_START_UTC - 2.5 * 3600, 200.0, ticket=1),
            _deal(DAY_START_UTC + 2 * 3600, -150.0, ticket=2),
        ]
        cfg = {"maxDailyLossPercent": 3.0, "brokerUtcOffsetHours": SERVER_OFFSET_H}
        res = self._compute(deals, cfg, account=_account(balance=3850.0))
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["dealCountToday"], 1)
        self.assertAlmostEqual(res["dailyRealizedLossUsd"], 150.0)
        # 3% of reconstructed 4000.00 day-start balance = 120.00 -> breached.
        self.assertTrue(res["dailyLimitBreached"])

    def test_wrong_zero_offset_would_have_masked_the_breach(self):
        """Documents the bug class: with offset 0 the +200 leaks into 'today'."""
        deals = [
            _deal(DAY_START_UTC - 1 * 3600, 200.0, ticket=1),  # 23:00 UTC yesterday = 01:00 server today
            _deal(DAY_START_UTC + 2 * 3600, -150.0, ticket=2),
        ]
        wrong = self._compute(deals, {"maxDailyLossPercent": 3.0, "brokerUtcOffsetHours": 0})
        self.assertEqual(wrong["dealCountToday"], 2)
        self.assertFalse(wrong["dailyLimitBreached"])
        shutil.rmtree(self.rt, ignore_errors=True)
        self.rt.mkdir(parents=True, exist_ok=True)
        right = self._compute(deals, {"maxDailyLossPercent": 3.0, "brokerUtcOffsetHours": SERVER_OFFSET_H})
        self.assertEqual(right["dealCountToday"], 1)
        self.assertAlmostEqual(right["dailyRealizedLossUsd"], 150.0)

    def test_cfg_value_takes_precedence_and_invalid_cfg_never_falls_back_to_env(self):
        with patch.dict(os.environ, {engine.BROKER_UTC_OFFSET_ENV: "2"}):
            res = self._compute([], {"maxDailyLossPercent": 3.0, "brokerUtcOffsetHours": "UTC+2"})
        self.assertFalse(res["ok"])
        self.assertIn("BROKER_UTC_OFFSET_UNVERIFIED", res["reason"])

    def test_default_daily_limit_is_three_percent(self):
        res = self._compute([], {"brokerUtcOffsetHours": 2})
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["maxDailyLossPercent"], 3.0)
        self.assertAlmostEqual(res["dailyLossLimitUsd"], 120.0)


if __name__ == "__main__":
    unittest.main()
