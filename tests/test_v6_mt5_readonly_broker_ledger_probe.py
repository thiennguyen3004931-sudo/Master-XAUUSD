"""Unit tests for Read-Only MT5 Broker-Owned Pricing, Inventory & Daily P&L Ledger Probe (#76)."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import Mock, patch
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import v6_mt5_readonly_broker_ledger_probe as probe


def _acct(**overrides):
    base = {
        "login": 999888362,
        "server": "DBGMarkets-Live",
        "currency": "USD",
        "trade_mode": 2,
        "margin_mode": 2,
        "equity": 10000.0,
        "margin_free": 9000.0,
        "margin_so_mode": 0,
        "margin_so_call": 100.0,
        "margin_so_so": 50.0,
    }
    base.update(overrides)
    return base


def _sym():
    return {
        "name": "XAUUSD.G",
        "trade_contract_size": 100.0,
        "volume_min": 0.01,
        "volume_max": 100.0,
        "volume_step": 0.01,
        "trade_stops_level": 50,
        "trade_freeze_level": 20,
        "point": 0.01,
    }


class TestMt5ReadonlyBrokerLedgerProbe(unittest.TestCase):
    def test_injected_snapshot_never_claims_broker_provenance_verified(self) -> None:
        rep = probe.build_broker_ledger_snapshot(
            account_info=_acct(),
            symbol_info=_sym(),
            tick_info={"bid": 2650.0, "ask": 2650.25, "time": 1795421000},
            positions=[{"profit": -35.5, "swap": -1.5}],
            pending_orders=[{"ticket": 777}],
            today_deals=[
                {"time": 1795420000, "entry": 0, "profit": 0.0, "commission": -3.0, "swap": 0.0, "fee": 0.0},
                {"time": 1795420500, "entry": 1, "profit": 50.0, "commission": -3.0, "swap": 0.0, "fee": 0.0},
            ],
            buy_calc_profit_1lot=-700.0,
            sell_calc_profit_1lot=-700.0,
            buy_calc_margin_1lot=2650.0,
            sell_calc_margin_1lot=2650.0,
            now_utc=1795421005,
            from_live_mt5=False,
        )
        self.assertFalse(rep["brokerProvenanceVerified"])
        self.assertEqual(rep["status"], "OFFLINE_SNAPSHOT_VALIDATED_PROVENANCE_UNVERIFIED")
        self.assertEqual(rep["account"]["accountMasked"], "***362")
        self.assertNotIn("999888362", json.dumps(rep))
        self.assertEqual(rep["inventoryAndDailyPnl"]["dailyRealizedPnl"], 44.0)
        self.assertEqual(rep["inventoryAndDailyPnl"]["dailyUnrealizedPnl"], -37.0)
        self.assertEqual(rep["inventoryAndDailyPnl"]["dailyTotalPnl"], 7.0)
        self.assertFalse(rep["orderSendCalled"])
        self.assertFalse(rep["liveAuthorized"])

    def test_utc_window_never_infers_offset_or_attests_caller(self) -> None:
        now = 1795487460
        for delta in (-172800, -3600, -900, -16, -15, 0, 1, 900, 6300, 7200, 10800):
            with self.subTest(delta=delta):
                rep = probe.build_broker_ledger_snapshot(
                    account_info=_acct(), symbol_info=_sym(), positions=[], pending_orders=[],
                    today_deals=[], tick_info={"time": now + delta, "bid": 100, "ask": 101},
                    buy_calc_profit_1lot=-1, sell_calc_profit_1lot=-1,
                    buy_calc_margin_1lot=1, sell_calc_margin_1lot=1, now_utc=now,
                    from_live_mt5=True,
                )
                self.assertEqual(rep["quote"]["rawUtcQuoteWindowPlausible"], -15 <= delta <= 0)
                self.assertIsNone(rep["quote"]["brokerServerUtcOffsetSeconds"])
                self.assertFalse(rep["quote"]["quoteFresh"])
                self.assertFalse(rep["brokerProvenanceVerified"])
                self.assertFalse(rep["liveAuthorized"])

    def test_mock_history_unavailable_at_utc_midnight_on_dst_weekends(self) -> None:
        # UTC diagnostic window only; neither weekend is a broker-day policy.
        for month, day in ((3, 29), (10, 25)):
            before = datetime(2026, month, day-1, 23, 59, 59, tzinfo=timezone.utc)
            end = datetime(2026, month, day, 0, 0, 1, tzinfo=timezone.utc)
            with self.subTest(end=end):
                mt5 = Mock(spec=["initialize", "account_info", "symbol_info", "symbol_info_tick",
                                 "positions_get", "orders_get", "history_deals_get", "shutdown"])
                mt5.initialize.return_value = True
                mt5.account_info.return_value._asdict.return_value = _acct()
                mt5.symbol_info.return_value._asdict.return_value = _sym()
                mt5.symbol_info_tick.return_value = None
                mt5.positions_get.return_value = ()
                mt5.orders_get.return_value = ()
                mt5.history_deals_get.return_value = None
                with patch.dict(sys.modules, {"MetaTrader5": mt5}), patch.object(probe, "datetime") as clock:
                    clock.now.side_effect = (before, end)
                    rep = probe.collect_live_mt5_readonly_ledger(allow_live_mt5_init=True)
                mt5.history_deals_get.assert_called_once_with(end.replace(second=0), end)
                mt5.shutdown.assert_called_once_with()
                self.assertEqual(rep["missingFields"], ["DAILY_DEALS_HISTORY_UNAVAILABLE", "TICK_INFO_MISSING"])
                self.assertEqual(rep["generatedAtUtc"], int(end.timestamp()))
                self.assertFalse(rep["brokerProvenanceVerified"])
                self.assertFalse(rep["liveAuthorized"])

    def test_malformed_position_or_deal_fails_closed_never_skips_silently(self) -> None:
        bad_pos = probe.build_broker_ledger_snapshot(
            account_info=_acct(),
            symbol_info=_sym(),
            tick_info={"bid": 2650.0, "ask": 2650.25, "time": 1795421000},
            positions=[{"profit": "nan", "swap": 0.0}],
            pending_orders=[],
            today_deals=[],
            buy_calc_profit_1lot=-700.0,
            sell_calc_profit_1lot=-700.0,
            buy_calc_margin_1lot=2650.0,
            sell_calc_margin_1lot=2650.0,
            now_utc=1795421005,
            from_live_mt5=True,
        )
        self.assertTrue(bad_pos["malformedRecordsDetected"])
        self.assertFalse(bad_pos["brokerProvenanceVerified"])
        self.assertEqual(bad_pos["status"], "MALFORMED_BROKER_RECORDS_FAIL_CLOSED")
        self.assertIsNone(bad_pos["inventoryAndDailyPnl"]["dailyTotalPnl"])

    def test_non_usd_currency_fails_closed(self) -> None:
        non_usd = probe.build_broker_ledger_snapshot(
            account_info=_acct(currency="EUR"),
            symbol_info=_sym(),
            tick_info={"bid": 2650.0, "ask": 2650.25, "time": 1795421000},
            positions=[],
            pending_orders=[],
            today_deals=[],
            buy_calc_profit_1lot=-700.0,
            sell_calc_profit_1lot=-700.0,
            buy_calc_margin_1lot=2650.0,
            sell_calc_margin_1lot=2650.0,
            now_utc=1795421005,
            from_live_mt5=True,
        )
        self.assertFalse(non_usd["brokerProvenanceVerified"])
        self.assertEqual(non_usd["status"], "NON_USD_ACCOUNT_CURRENCY_UNSUPPORTED")


if __name__ == "__main__":
    unittest.main()
    
