"""Unit tests for Read-Only MT5 Broker-Owned Pricing, Inventory & Daily P&L Ledger Probe (#76)."""

from __future__ import annotations

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

    def test_non_usd_currency_and_stale_tick_fail_closed(self) -> None:
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
        self.assertEqual(non_usd["inventoryAndDailyPnl"]["currency"], "EUR")


if __name__ == "__main__":
    unittest.main()
