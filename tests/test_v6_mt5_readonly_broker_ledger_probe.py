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


class TestMt5ReadonlyBrokerLedgerProbe(unittest.TestCase):
    def test_complete_fresh_broker_snapshot_computes_daily_pnl_and_masks_login(self) -> None:
        rep = probe.build_broker_ledger_snapshot(
            account_info={
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
            },
            symbol_info={
                "name": "XAUUSD.G",
                "trade_contract_size": 100.0,
                "volume_min": 0.01,
                "volume_max": 100.0,
                "volume_step": 0.01,
                "trade_stops_level": 50,
                "trade_freeze_level": 20,
                "point": 0.01,
            },
            tick_info={"bid": 2650.0, "ask": 2650.25, "time": 1795421000},
            positions=[{"profit": -35.5, "swap": -1.5}],
            pending_orders=[{"ticket": 777}],
            today_deals=[{"profit": 50.0, "commission": -3.0, "swap": 0.0, "fee": 0.0}],
            buy_calc_profit_1lot=-700.0,
            sell_calc_profit_1lot=-700.0,
            buy_calc_margin_1lot=2650.0,
            sell_calc_margin_1lot=2650.0,
            now_utc=1795421005,
        )
        self.assertTrue(rep["brokerProvenanceVerified"])
        self.assertEqual(rep["status"], "BROKER_READONLY_LEDGER_VERIFIED")
        self.assertEqual(rep["account"]["accountMasked"], "***362")
        self.assertNotIn("999888362", json.dumps(rep))
        self.assertEqual(rep["account"]["marginMode"], "HEDGING")
        self.assertEqual(rep["inventoryAndDailyPnl"]["dailyRealizedPnlUsd"], 47.0)
        self.assertEqual(rep["inventoryAndDailyPnl"]["dailyUnrealizedPnlUsd"], -37.0)
        self.assertEqual(rep["inventoryAndDailyPnl"]["dailyTotalPnlUsd"], 10.0)
        self.assertFalse(rep["orderSendCalled"])
        self.assertFalse(rep["liveAuthorized"])
        self.assertFalse(rep["secretsExposed"])

    def test_missing_broker_objects_or_stale_tick_fails_closed(self) -> None:
        inc = probe.build_broker_ledger_snapshot(
            account_info=None,
            symbol_info=None,
            tick_info=None,
            positions=None,
            pending_orders=None,
            today_deals=None,
            buy_calc_profit_1lot=None,
            sell_calc_profit_1lot=None,
            buy_calc_margin_1lot=None,
            sell_calc_margin_1lot=None,
            now_utc=1795421005,
        )
        self.assertFalse(inc["brokerProvenanceVerified"])
        self.assertEqual(inc["status"], "BROKER_READONLY_INCOMPLETE")
        self.assertFalse(inc["liveAuthorized"])

        stale = probe.build_broker_ledger_snapshot(
            account_info={"login": 123456, "server": "S", "currency": "USD", "trade_mode": 2, "margin_mode": 0, "equity": 1000.0, "margin_free": 900.0},
            symbol_info={"name": "XAUUSD.G", "trade_contract_size": 100.0, "volume_min": 0.01, "volume_max": 10.0, "volume_step": 0.01},
            tick_info={"bid": 2650.0, "ask": 2650.2, "time": 1795420900},
            positions=[],
            pending_orders=[],
            today_deals=[],
            buy_calc_profit_1lot=-700.0,
            sell_calc_profit_1lot=-700.0,
            buy_calc_margin_1lot=2650.0,
            sell_calc_margin_1lot=2650.0,
            now_utc=1795421005,
        )
        self.assertFalse(stale["brokerProvenanceVerified"])
        self.assertEqual(stale["status"], "BROKER_READONLY_PARTIAL_OR_STALE")
        self.assertEqual(stale["account"]["marginMode"], "NETTING")


if __name__ == "__main__":
    unittest.main()
