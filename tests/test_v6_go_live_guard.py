"""hardening/go-live: unit + mock-broker integration tests for the go-live guard.

The guard is tested with its REAL defaults: every XAUUSD_* variable that the
offline harness relaxes for legacy suites is removed for these tests.
"""
from __future__ import annotations

import datetime as dt
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

import v6_go_live_guard as guard

spec = importlib.util.spec_from_file_location("xauusd_mt5_direct_probe_guard", SCRIPTS / "mt5-direct-probe.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)

try:
    from tests.test_v6_mandatory_t01_t20 import SafeMockBroker
except ImportError:  # discover -s tests imports modules top-level
    from test_v6_mandatory_t01_t20 import SafeMockBroker

# Tuesday 2026-11-24 10:00 UTC: liquid London session, no weekend.
LIQUID_NOW = dt.datetime(2026, 11, 24, 10, 0, tzinfo=dt.timezone.utc).timestamp()


def clean_env(**overrides):
    env = {k: v for k, v in os.environ.items() if not k.startswith("XAUUSD_")}
    env.update(overrides)
    return env


def settings(tmp: Path, **env):
    base = {
        "XAUUSD_KILL_SWITCH_FILE": str(tmp / "KILL_SWITCH"),
        "XAUUSD_GUARD_LOG_FILE": str(tmp / "guard.jsonl"),
        "XAUUSD_NEWS_BLACKOUT_FILE": str(tmp / "news.json"),
    }
    base.update(env)
    return guard.load_settings(base)


def write_calendar(tmp: Path, events, valid_until="2026-12-31T23:59:00Z"):
    (tmp / "news.json").write_text(json.dumps({"validUntil": valid_until, "events": events}), encoding="utf-8")


class ExecutionModeTests(unittest.TestCase):
    def test_defaults_are_dry_run_and_not_live(self):
        s = guard.load_settings({})
        self.assertTrue(s.dry_run)
        self.assertFalse(s.live_confirmed)
        self.assertEqual(s.risk_per_trade_pct, 1.0)
        self.assertEqual(s.max_daily_loss_pct, 3.0)

    def test_dry_run_blocks_every_mutation_but_operator_flatten(self):
        s = guard.load_settings({})
        for action in ("order", "dca_plus", "manage_positions", "breakeven", "close"):
            block = guard.execution_mode_block(action, real_account=False, settings=s)
            self.assertEqual(block["status"], "DRY_RUN_NO_BROKER_MUTATION", action)
        self.assertIsNone(guard.execution_mode_block("kill_switch_flatten", real_account=True, settings=s))
        self.assertIsNone(guard.execution_mode_block("probe", real_account=True, settings=s))

    def test_live_requires_both_flags(self):
        cases = [
            ({"XAUUSD_DRY_RUN": "false"}, True),
            ({"XAUUSD_DRY_RUN": "false", "XAUUSD_LIVE": "true"}, True),
            ({"XAUUSD_DRY_RUN": "false", "XAUUSD_CONFIRM_LIVE": "yes"}, True),
            ({"XAUUSD_DRY_RUN": "false", "XAUUSD_LIVE": "true", "XAUUSD_CONFIRM_LIVE": "true"}, True),
            ({"XAUUSD_DRY_RUN": "false", "XAUUSD_LIVE": "true", "XAUUSD_CONFIRM_LIVE": "yes"}, False),
        ]
        for env, blocked in cases:
            s = guard.load_settings(env)
            block = guard.execution_mode_block("order", real_account=True, settings=s)
            self.assertEqual(block is not None, blocked, env)
            # DEMO accounts only need DRY_RUN=false.
            self.assertIsNone(guard.execution_mode_block("order", real_account=False, settings=s))

    def test_protective_actions_allowed_on_real_without_live_flags(self):
        s = guard.load_settings({"XAUUSD_DRY_RUN": "false"})
        for action in ("manage_positions", "breakeven", "close"):
            self.assertIsNone(guard.execution_mode_block(action, real_account=True, settings=s))

    def test_env_cannot_raise_hard_caps(self):
        s = guard.load_settings({
            "XAUUSD_RISK_PER_TRADE_PCT": "5", "XAUUSD_MAX_PORTFOLIO_RISK_PCT": "9",
            "XAUUSD_MAX_DAILY_LOSS_PCT": "10", "XAUUSD_MAX_WEEKLY_LOSS_PCT": "50",
        })
        self.assertEqual((s.risk_per_trade_pct, s.max_portfolio_risk_pct, s.max_daily_loss_pct, s.max_weekly_loss_pct),
                         (1.0, 1.5, 3.0, 6.0))

    def test_invalid_liquidity_window_config_blocks_all_day(self):
        s = guard.load_settings({"XAUUSD_LOW_LIQUIDITY_WINDOWS_UTC": "garbage"})
        self.assertIsNotNone(guard.check_low_liquidity(LIQUID_NOW, s))


class SizingTests(unittest.TestCase):
    def test_risk_volume_floors_to_step(self):
        # 4000 * 1% = 40 USD; 1 lot loses 6.8 * 100 * 1.05 = 714 USD -> 0.056 -> 0.05
        v = guard.compute_risk_volume(equity=4000, risk_pct=1.0, loss_per_lot_usd=714.0,
                                      volume_min=0.01, volume_step=0.01, volume_max=100)
        self.assertEqual(v, 0.05)

    def test_risk_volume_respects_max_and_min(self):
        self.assertEqual(guard.compute_risk_volume(equity=1e9, risk_pct=1, loss_per_lot_usd=100,
                                                   volume_min=0.01, volume_step=0.01, volume_max=50), 50)
        self.assertIsNone(guard.compute_risk_volume(equity=100, risk_pct=1, loss_per_lot_usd=714,
                                                    volume_min=0.01, volume_step=0.01, volume_max=50))

    def test_risk_volume_rejects_invalid_inputs(self):
        for bad in (0, -1, float("nan"), float("inf")):
            self.assertIsNone(guard.compute_risk_volume(equity=bad, risk_pct=1, loss_per_lot_usd=714,
                                                        volume_min=0.01, volume_step=0.01, volume_max=50))
            self.assertIsNone(guard.compute_risk_volume(equity=4000, risk_pct=1, loss_per_lot_usd=bad,
                                                        volume_min=0.01, volume_step=0.01, volume_max=50))

    def test_floor_to_step_handles_float_noise(self):
        self.assertEqual(guard.floor_to_step(0.07, 0.01), 0.07)
        self.assertEqual(guard.floor_to_step(0.2999999, 0.1), 0.2)
        self.assertEqual(guard.floor_to_step(3, 1), 3)


class DeviationTests(unittest.TestCase):
    def test_defaults_and_hard_caps(self):
        s = guard.load_settings(clean_env())
        self.assertEqual((s.entry_deviation_points, s.close_deviation_points), (50, 50))
        s = guard.load_settings(clean_env(XAUUSD_ENTRY_DEVIATION_POINTS="5000", XAUUSD_CLOSE_DEVIATION_POINTS="5000"))
        self.assertEqual(s.entry_deviation_points, guard.HARD_MAX_ENTRY_DEVIATION_POINTS)
        self.assertEqual(s.close_deviation_points, guard.HARD_MAX_CLOSE_DEVIATION_POINTS)
        s = guard.load_settings(clean_env(XAUUSD_ENTRY_DEVIATION_POINTS="0", XAUUSD_CLOSE_DEVIATION_POINTS="abc"))
        self.assertEqual((s.entry_deviation_points, s.close_deviation_points), (1, 50))

    def test_kind_selects_entry_or_close(self):
        s = guard.load_settings(clean_env(XAUUSD_ENTRY_DEVIATION_POINTS="20", XAUUSD_CLOSE_DEVIATION_POINTS="120"))
        self.assertEqual(guard.deviation_points("entry", s), 20)
        self.assertEqual(guard.deviation_points("close", s), 120)


class SlippageTests(unittest.TestCase):
    def test_measures_and_flags_above_limit(self):
        s = guard.load_settings(clean_env(XAUUSD_MAX_SLIPPAGE_USD="0.30"))
        self.assertEqual(guard.check_slippage(2650.00, 2650.20, s), {"slippageUsd": 0.2, "exceeded": False, "limitUsd": 0.3})
        self.assertTrue(guard.check_slippage(2650.00, 2649.55, s)["exceeded"])

    def test_missing_prices_are_not_flagged(self):
        s = guard.load_settings(clean_env())
        for req, fill in ((None, 2650.0), (2650.0, 0), ("x", 1), (float("nan"), 2650.0)):
            res = guard.check_slippage(req, fill, s)
            self.assertIsNone(res["slippageUsd"])
            self.assertFalse(res["exceeded"])


class ExposureSpreadClockTests(unittest.TestCase):
    def setUp(self):
        self.s = guard.load_settings({"XAUUSD_MAX_OPEN_POSITIONS": "2", "XAUUSD_MAX_TOTAL_VOLUME_LOTS": "0.10"})

    def test_max_open_positions(self):
        pos = [SimpleNamespace(volume=0.01), SimpleNamespace(volume=0.01)]
        self.assertEqual(guard.check_exposure_limits(pos, 0.01, self.s)["status"], "BLOCKED_MAX_OPEN_POSITIONS")
        self.assertIsNone(guard.check_exposure_limits(pos[:1], 0.01, self.s))

    def test_max_total_volume(self):
        pos = [SimpleNamespace(volume=0.08)]
        self.assertEqual(guard.check_exposure_limits(pos, 0.03, self.s)["status"], "BLOCKED_MAX_TOTAL_VOLUME")
        self.assertIsNone(guard.check_exposure_limits(pos, 0.02, self.s))

    def test_unreadable_volume_fails_closed(self):
        res = guard.check_exposure_limits([SimpleNamespace(volume=None)], 0.01, self.s)
        self.assertEqual(res["status"], "BLOCKED_PORTFOLIO_RISK_UNVERIFIED")

    def test_spread_filter(self):
        s = guard.load_settings({"XAUUSD_MAX_SPREAD_USD": "0.40"})
        self.assertIsNone(guard.check_spread(4000.00, 4000.40, s))
        self.assertEqual(guard.check_spread(4000.00, 4000.41, s)["status"], "BLOCKED_SPREAD_TOO_WIDE")
        self.assertEqual(guard.check_spread(4000.00, 3999.0, s)["status"], "BLOCKED_INVALID_QUOTE")
        self.assertEqual(guard.check_spread(None, 1, s)["status"], "BLOCKED_INVALID_QUOTE")

    def test_clock_skew(self):
        s = guard.load_settings({})
        self.assertIsNone(guard.check_clock_skew(LIQUID_NOW + 4, LIQUID_NOW, s))
        self.assertEqual(guard.check_clock_skew(LIQUID_NOW + 30, LIQUID_NOW, s)["status"], "BLOCKED_CLOCK_SKEW")
        self.assertEqual(guard.check_clock_skew(float("nan"), LIQUID_NOW, s)["status"], "BLOCKED_CLOCK_UNVERIFIED")


class CalendarTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="v6-guard-cal-"))

    def test_missing_calendar_blocks_when_filter_enabled(self):
        s = settings(self.tmp)
        self.assertEqual(guard.check_news_blackout(LIQUID_NOW, s)["status"], "BLOCKED_NEWS_CALENDAR_UNAVAILABLE")
        s_off = settings(self.tmp, XAUUSD_NEWS_FILTER_ENABLED="false")
        self.assertIsNone(guard.check_news_blackout(LIQUID_NOW, s_off))

    def test_expired_and_invalid_calendar_block(self):
        write_calendar(self.tmp, [], valid_until="2026-01-01T00:00:00Z")
        self.assertEqual(guard.check_news_blackout(LIQUID_NOW, settings(self.tmp))["status"], "BLOCKED_NEWS_CALENDAR_EXPIRED")
        (self.tmp / "news.json").write_text("{not json", encoding="utf-8")
        self.assertEqual(guard.check_news_blackout(LIQUID_NOW, settings(self.tmp))["status"], "BLOCKED_NEWS_CALENDAR_UNAVAILABLE")
        write_calendar(self.tmp, [{"name": "CPI", "timeUtc": "2026-11-24T13:30:00"}])  # no tz -> invalid
        self.assertEqual(guard.check_news_blackout(LIQUID_NOW, settings(self.tmp))["status"], "BLOCKED_NEWS_CALENDAR_UNAVAILABLE")

    def test_blackout_window_edges(self):
        write_calendar(self.tmp, [{"name": "US CPI", "timeUtc": "2026-11-24T13:30:00Z"},
                                  {"name": "FOMC", "timeUtc": "2026-11-24T19:00:00Z", "beforeMin": 60, "afterMin": 90}])
        s = settings(self.tmp)
        cpi = dt.datetime(2026, 11, 24, 13, 30, tzinfo=dt.timezone.utc).timestamp()
        self.assertIsNone(guard.check_news_blackout(cpi - 31 * 60, s))
        self.assertEqual(guard.check_news_blackout(cpi - 30 * 60, s)["status"], "BLOCKED_NEWS_BLACKOUT")
        self.assertEqual(guard.check_news_blackout(cpi + 30 * 60, s)["status"], "BLOCKED_NEWS_BLACKOUT")
        self.assertIsNone(guard.check_news_blackout(cpi + 31 * 60, s))
        fomc = dt.datetime(2026, 11, 24, 19, 0, tzinfo=dt.timezone.utc).timestamp()
        self.assertIsNotNone(guard.check_news_blackout(fomc - 59 * 60, s))
        self.assertIsNotNone(guard.check_news_blackout(fomc + 89 * 60, s))

    def test_low_liquidity_windows(self):
        s = guard.load_settings({})
        at = lambda d, h, m: dt.datetime(2026, 11, d, h, m, tzinfo=dt.timezone.utc).timestamp()
        self.assertIsNone(guard.check_low_liquidity(at(24, 10, 0), s))           # Tue
        self.assertIsNotNone(guard.check_low_liquidity(at(24, 21, 30), s))       # rollover
        self.assertIsNotNone(guard.check_low_liquidity(at(27, 20, 5), s))        # Fri close
        self.assertIsNotNone(guard.check_low_liquidity(at(28, 12, 0), s))        # Sat
        self.assertIsNotNone(guard.check_low_liquidity(at(30, 0, 30), s))        # Mon open
        self.assertIsNone(guard.check_low_liquidity(at(30, 2, 0), s))
        self.assertIsNone(guard.check_low_liquidity(at(28, 12, 0), guard.load_settings({"XAUUSD_LOW_LIQUIDITY_FILTER_ENABLED": "false"})))

    def test_wraparound_window(self):
        s = guard.load_settings({"XAUUSD_LOW_LIQUIDITY_WINDOWS_UTC": "23:00-01:00"})
        t = dt.datetime(2026, 11, 25, 0, 30, tzinfo=dt.timezone.utc).timestamp()
        self.assertIsNotNone(guard.check_low_liquidity(t, s))


class LossLimitTests(unittest.TestCase):
    def deal(self, t, profit, dtype=0, commission=0.0, swap=0.0, fee=0.0):
        return SimpleNamespace(time=t, type=dtype, profit=profit, commission=commission, swap=swap, fee=fee)

    def test_week_start_is_monday_in_broker_time(self):
        ws = guard.week_start_utc(LIQUID_NOW, 0)
        self.assertEqual(dt.datetime.fromtimestamp(ws, tz=dt.timezone.utc).isoformat(), "2026-11-23T00:00:00+00:00")
        ws2 = guard.week_start_utc(LIQUID_NOW, 2)
        self.assertEqual(ws2, ws - 7200)

    def test_weekly_limit_blocks_and_excludes_balance_deals(self):
        s = guard.load_settings({})
        ws = guard.week_start_utc(LIQUID_NOW, 0)
        deals = [
            self.deal(ws - 100, -9999),                 # last week -> ignored
            self.deal(ws + 100, -150, commission=-5),   # counted
            self.deal(ws + 200, 5000, dtype=2),         # deposit -> ignored
            self.deal(ws + 300, -100),                  # counted
        ]
        # balance now 3745 after -255 realized -> week start 4000 -> limit 240 (6%)
        res = guard.check_weekly_loss(deals=deals, balance=3745, equity=3745, now_utc=LIQUID_NOW,
                                      broker_offset_hours=0, settings=s)
        self.assertFalse(res["ok"])
        self.assertEqual(res["status"], "BLOCKED_WEEKLY_LOSS_LIMIT")
        self.assertEqual(res["weekStartBalanceUsd"], 4000.0)

    def test_weekly_projection_with_new_order(self):
        s = guard.load_settings({})
        ws = guard.week_start_utc(LIQUID_NOW, 0)
        deals = [self.deal(ws + 100, -200)]
        ok = guard.check_weekly_loss(deals=deals, balance=3800, equity=3800, now_utc=LIQUID_NOW,
                                     broker_offset_hours=0, settings=s, new_order_risk_usd=30)
        self.assertTrue(ok["ok"])
        blocked = guard.check_weekly_loss(deals=deals, balance=3800, equity=3800, now_utc=LIQUID_NOW,
                                          broker_offset_hours=0, settings=s, new_order_risk_usd=41)
        self.assertEqual(blocked["status"], "BLOCKED_WEEKLY_LOSS_LIMIT")

    def test_weekly_fails_closed_without_history_or_offset(self):
        s = guard.load_settings({})
        self.assertEqual(guard.check_weekly_loss(deals=None, balance=1, equity=1, now_utc=LIQUID_NOW,
                                                 broker_offset_hours=0, settings=s)["status"], "BLOCKED_WEEKLY_HISTORY_UNVERIFIED")
        self.assertEqual(guard.check_weekly_loss(deals=[], balance=1, equity=1, now_utc=LIQUID_NOW,
                                                 broker_offset_hours=None, settings=s)["status"], "BLOCKED_WEEKLY_HISTORY_UNVERIFIED")
        bad = [SimpleNamespace(time=LIQUID_NOW, type=0, profit=float("nan"), commission=0, swap=0, fee=0)]
        self.assertEqual(guard.check_weekly_loss(deals=bad, balance=1, equity=1, now_utc=LIQUID_NOW,
                                                 broker_offset_hours=0, settings=s)["status"], "BLOCKED_WEEKLY_HISTORY_UNVERIFIED")

    def test_floating_loss_counts(self):
        s = guard.load_settings({})
        res = guard.check_weekly_loss(deals=[], balance=4000, equity=3750, now_utc=LIQUID_NOW,
                                      broker_offset_hours=0, settings=s)
        self.assertEqual(res["status"], "BLOCKED_WEEKLY_LOSS_LIMIT")


class KillSwitchAndOpsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="v6-guard-ks-"))
        self.s = settings(self.tmp)

    def test_file_kill_switch_roundtrip(self):
        self.assertEqual(guard.kill_switch_active(self.s), (False, None))
        guard.activate_kill_switch(self.s, "test", flatten=True)
        self.assertEqual(guard.kill_switch_active(self.s), (True, "KILL_SWITCH_FILE"))
        payload = json.loads(self.s.kill_switch_file.read_text(encoding="utf-8"))
        self.assertTrue(payload["flattenRequested"])
        self.assertTrue(guard.deactivate_kill_switch(self.s))
        self.assertFalse(guard.kill_switch_active(self.s)[0])

    def test_env_kill_switch(self):
        s = settings(self.tmp, XAUUSD_KILL_SWITCH="1")
        self.assertEqual(guard.kill_switch_active(s), (True, "KILL_SWITCH_ENV"))

    def test_redaction_never_leaks_secrets_or_full_login(self):
        token = "1234567890:" + "A" * 35
        out = guard.redact({"password": "hunter2", "accountLogin": 52013620, "nested": {"botToken": token},
                            "message": f"failed with {token}", "chatId": "987654321"})
        text = json.dumps(out)
        self.assertNotIn("hunter2", text)
        self.assertNotIn("52013620", text)
        self.assertNotIn(token, text)
        self.assertNotIn("987654321", text)
        self.assertIn("***620", text)

    def test_log_event_is_redacted_jsonl(self):
        guard.log_event("X", {"password": "p", "login": 123456}, settings=self.s)
        line = self.s.log_file.read_text(encoding="utf-8").strip()
        rec = json.loads(line)
        self.assertEqual(rec["password"], "[REDACTED]")
        self.assertEqual(rec["login"], "***456")

    def test_alert_requires_env_and_dedupes(self):
        sent = []
        state = self.tmp / "alerts.json"
        env = {"TELEGRAM_BOT_TOKEN": "t", "TELEGRAM_CHAT_ID": "c"}
        self.assertFalse(guard.send_alert("E", "x", env={}, state_file=state, transport=lambda u, b: sent.append(u)))
        self.assertTrue(guard.send_alert("E", "x", env=env, state_file=state, transport=lambda u, b: sent.append(u), now=1000))
        self.assertFalse(guard.send_alert("E", "x", env=env, state_file=state, transport=lambda u, b: sent.append(u), now=1100))
        self.assertTrue(guard.send_alert("E", "x", env=env, state_file=state, transport=lambda u, b: sent.append(u), now=2000))
        self.assertFalse(guard.send_alert("E", "x", env={**env, "XAUUSD_ALERTS_DISABLED": "1"}, state_file=state,
                                          transport=lambda u, b: sent.append(u), now=9999))
        self.assertEqual(len(sent), 2)

    def test_alert_transport_failure_never_raises(self):
        def boom(u, b):
            raise OSError("network down")
        self.assertFalse(guard.send_alert("E", "x", env={"TELEGRAM_BOT_TOKEN": "t", "TELEGRAM_CHAT_ID": "c"},
                                          state_file=self.tmp / "a.json", transport=boom))

    def test_heartbeat(self):
        hb = self.tmp / "hb.json"
        guard.write_heartbeat({"connected": True, "accountLogin": 99887766}, path=hb, now=1000)
        self.assertEqual(guard.heartbeat_age_sec(hb, now=1030), 30)
        self.assertNotIn("99887766", hb.read_text(encoding="utf-8"))
        self.assertIsNone(guard.heartbeat_age_sec(self.tmp / "missing.json"))

    def test_retry_with_backoff(self):
        calls, sleeps = [], []
        res = guard.retry_with_backoff(lambda: calls.append(1) or len(calls) >= 3, attempts=5, base_delay=1,
                                       sleep=sleeps.append)
        self.assertTrue(res)
        self.assertEqual(sleeps, [1, 2])
        res2 = guard.retry_with_backoff(lambda: False, attempts=3, base_delay=1, max_delay=1.5, sleep=sleeps.append)
        self.assertFalse(res2)
        self.assertEqual(sleeps[-2:], [1, 1.5])


class GatewayIntegrationTests(unittest.TestCase):
    """Drive the real execute_order() path against the offline mock broker."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="v6-guard-int-"))
        engine.RUNTIME_DIR = self.tmp
        engine.MANAGER_STATE_FILE = self.tmp / "mgr.json"
        engine.DAILY_RISK_STATE_FILE = self.tmp / "daily.json"
        engine.REGIME_STATE_FILE = self.tmp / "regime.json"
        p = mock.patch.object(engine, "_check_runtime_emergency_stop_latch", return_value=None)
        p.start()
        self.addCleanup(p.stop)
        t = mock.patch.object(engine.time, "time", return_value=LIQUID_NOW)
        t.start()
        self.addCleanup(t.stop)
        write_calendar(self.tmp, [{"name": "US CPI", "timeUtc": "2026-11-24T13:30:00Z"}])

    def env(self, **extra):
        return clean_env(
            V6_BROKER_UTC_OFFSET_HOURS="0",
            XAUUSD_KILL_SWITCH_FILE=str(self.tmp / "KILL_SWITCH"),
            XAUUSD_GUARD_LOG_FILE=str(self.tmp / "guard.jsonl"),
            XAUUSD_NEWS_BLACKOUT_FILE=str(self.tmp / "news.json"),
            XAUUSD_ALERTS_DISABLED="true",
            **extra,
        )

    def broker(self, **kw):
        b = SafeMockBroker(**kw)
        b.tick_time = int(LIQUID_NOW)
        return b

    def order(self, mt5, volume=0.02):
        return engine.execute_order(mt5, "XAUUSD.G", {"side": "BUY", "volume": volume, "slDistance": 6.8, "tpDistance": 16.0})

    def test_default_env_is_dry_run_and_sends_nothing(self):
        mt5 = self.broker()
        with mock.patch.dict(os.environ, self.env(), clear=True):
            res = self.order(mt5)
        self.assertFalse(res["ok"])
        self.assertEqual(res["status"], "DRY_RUN_NO_BROKER_MUTATION")
        self.assertEqual(mt5.sent, [])

    def test_demo_with_dry_run_false_sends_risk_sized_order(self):
        mt5 = self.broker()

        def send_and_fill(req):
            mt5.sent.append(req)
            mt5.positions.append(SimpleNamespace(
                ticket=991, identifier=991, symbol=req["symbol"], type=req["type"], volume=req["volume"],
                price_open=req["price"], price_current=req["price"], sl=req["sl"], tp=req["tp"],
                magic=270715, comment=req["comment"]))
            return SimpleNamespace(retcode=10009, order=991, deal=992, volume=req["volume"], price=req["price"])
        mt5.order_send = send_and_fill
        with mock.patch.dict(os.environ, self.env(XAUUSD_DRY_RUN="false"), clear=True):
            res = self.order(mt5, volume=0.10)
        self.assertTrue(res["ok"], res)
        self.assertEqual(len(mt5.sent), 1)
        self.assertEqual(mt5.sent[0]["volume"], 0.05)   # reduced from 0.10 to the 1% cap
        self.assertTrue(mt5.sent[0]["sl"] > 0)
        self.assertEqual(mt5.sent[0]["deviation"], 50)
        self.assertEqual(res["requestedPrice"], mt5.sent[0]["price"])
        self.assertEqual(res["fillPrice"], mt5.sent[0]["price"])

    def test_entry_deviation_from_env_is_used(self):
        mt5 = self.broker()

        def send_and_fill(req):
            mt5.sent.append(req)
            mt5.positions.append(SimpleNamespace(
                ticket=993, identifier=993, symbol=req["symbol"], type=req["type"], volume=req["volume"],
                price_open=req["price"], price_current=req["price"], sl=req["sl"], tp=req["tp"],
                magic=270715, comment=req["comment"]))
            return SimpleNamespace(retcode=10009, order=993, deal=994, volume=req["volume"], price=req["price"])
        mt5.order_send = send_and_fill
        with mock.patch.dict(os.environ, self.env(XAUUSD_DRY_RUN="false", XAUUSD_ENTRY_DEVIATION_POINTS="20"), clear=True):
            res = self.order(mt5)
        self.assertTrue(res["ok"], res)
        self.assertEqual(mt5.sent[0]["deviation"], 20)

    def test_real_account_needs_live_and_confirm(self):
        mt5 = self.broker(trade_mode=2)
        with mock.patch.dict(os.environ, self.env(XAUUSD_DRY_RUN="false", XAUUSD_LIVE="true"), clear=True):
            res = engine.execute_order(mt5, "XAUUSD.G", {
                "side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16.0,
                "login": str(mt5.login_id), "server": mt5.server_name, "accountMode": "LIVE",
                "liveAuthorized": True, "liveArmed": True, "explicitLiveGateConfirmed": True,
            })
        self.assertFalse(res["ok"])
        self.assertEqual(mt5.sent, [])

    def test_kill_switch_blocks_new_entries(self):
        mt5 = self.broker()
        (self.tmp / "KILL_SWITCH").write_text("{}", encoding="utf-8")
        with mock.patch.dict(os.environ, self.env(XAUUSD_DRY_RUN="false"), clear=True):
            res = self.order(mt5)
        self.assertEqual(res["status"], "BLOCKED_KILL_SWITCH")
        self.assertEqual(mt5.sent, [])

    def test_news_blackout_blocks(self):
        mt5 = self.broker()
        cpi = dt.datetime(2026, 11, 24, 13, 20, tzinfo=dt.timezone.utc).timestamp()
        mt5.tick_time = int(cpi)
        with mock.patch.object(engine.time, "time", return_value=cpi), \
                mock.patch.dict(os.environ, self.env(XAUUSD_DRY_RUN="false"), clear=True):
            res = self.order(mt5)
        self.assertEqual(res["status"], "BLOCKED_NEWS_BLACKOUT")
        self.assertEqual(mt5.sent, [])

    def test_wide_spread_blocks(self):
        mt5 = self.broker()
        mt5.asks = 4000.60
        with mock.patch.dict(os.environ, self.env(XAUUSD_DRY_RUN="false"), clear=True):
            res = engine.execute_order(mt5, "XAUUSD.G", {"side": "BUY", "volume": 0.02, "slDistance": 6.8,
                                                         "tpDistance": 16.0, "maxSpreadPoints": 1000})
        self.assertEqual(res["status"], "BLOCKED_SPREAD_TOO_WIDE")
        self.assertEqual(mt5.sent, [])

    def test_max_open_positions_blocks(self):
        mt5 = self.broker()
        mt5.positions = [SimpleNamespace(ticket=i, symbol="XAUUSD.G", type=0, volume=0.01, price_open=4000.0,
                                         sl=3999.0, tp=4010.0) for i in range(1, 4)]
        with mock.patch.dict(os.environ, self.env(XAUUSD_DRY_RUN="false"), clear=True):
            res = self.order(mt5, volume=0.01)
        self.assertEqual(res["status"], "BLOCKED_MAX_OPEN_POSITIONS")
        self.assertEqual(mt5.sent, [])

    def test_weekly_loss_blocks(self):
        mt5 = self.broker(equity=3700.0)
        mt5.balance = 3700.0
        ws = guard.week_start_utc(LIQUID_NOW, 0)
        # Loss realized earlier this week (Monday), not today -> daily gate passes, weekly trips.
        mt5.deals = [SimpleNamespace(time=ws + 3600, type=0, entry=1, profit=-300.0, commission=0.0, swap=0.0,
                                     fee=0.0, symbol="XAUUSD.G", magic=270715, position_id=1, ticket=1, volume=0.1)]
        with mock.patch.dict(os.environ, self.env(XAUUSD_DRY_RUN="false"), clear=True):
            res = self.order(mt5, volume=0.02)
        self.assertEqual(res["status"], "BLOCKED_WEEKLY_LOSS_LIMIT", res)
        self.assertEqual(mt5.sent, [])

    def test_daily_cap_cannot_be_raised_by_client_cfg(self):
        mt5 = self.broker()
        captured = {}
        real = engine.compute_and_persist_daily_loss_state

        def spy(mt5_, account, cfg, **kw):
            captured["pct"] = cfg.get("maxDailyLossPercent")
            return real(mt5_, account, cfg, **kw)

        with mock.patch.object(engine, "compute_and_persist_daily_loss_state", side_effect=spy), \
                mock.patch.dict(os.environ, self.env(XAUUSD_DRY_RUN="false"), clear=True):
            engine.execute_order(mt5, "XAUUSD.G", {"side": "BUY", "volume": 0.02, "slDistance": 6.8,
                                                   "tpDistance": 16.0, "maxDailyLossPercent": 5.0})
        self.assertEqual(captured["pct"], 3.0)



class FlattenReportTests(unittest.TestCase):
    """Kill-switch flatten reports leftover gold exposure (AUDIT E-2)."""

    class Broker:
        def __init__(self, positions, orders):
            self.positions, self.orders = positions, orders

        def positions_get(self):
            return list(self.positions)

        def orders_get(self):
            if isinstance(self.orders, Exception):
                raise self.orders
            return self.orders

    def run_flatten(self, positions, orders):
        mt5 = self.Broker(positions, orders)

        def close(_mt5, ticket):
            mt5.positions = [p for p in mt5.positions if p.ticket != ticket]
            return {"ok": True}
        with mock.patch.object(engine, "close_position_by_ticket", side_effect=close):
            return engine._flatten_gold_exposure(mt5, list(positions))

    def pos(self, ticket, symbol="XAUUSD.G"):
        return SimpleNamespace(ticket=ticket, symbol=symbol)

    def test_clean_when_no_gold_left(self):
        res = self.run_flatten([self.pos(1), self.pos(2, "EURUSD")], [SimpleNamespace(ticket=9, symbol="EURUSD")])
        self.assertTrue(res["ok"])
        self.assertEqual(res["status"], "KILL_SWITCH_FLATTENED")
        self.assertEqual(len(res["closed"]), 1)

    def test_pending_gold_orders_are_reported(self):
        res = self.run_flatten([self.pos(1)], [SimpleNamespace(ticket=7, symbol="XAUUSD.G")])
        self.assertFalse(res["ok"])
        self.assertEqual(res["status"], "KILL_SWITCH_FLATTEN_INCOMPLETE")
        self.assertEqual(res["pendingOrderTickets"], ["7"])
        self.assertTrue(res["operatorAction"])

    def test_unreadable_order_book_is_incomplete(self):
        for orders in (None, RuntimeError("terminal")):
            res = self.run_flatten([self.pos(1)], orders)
            self.assertFalse(res["ok"])
            self.assertFalse(res["pendingOrdersVerified"])

if __name__ == "__main__":
    unittest.main()
