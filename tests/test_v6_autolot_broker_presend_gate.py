"""Unit tests for V6 Auto Lot Same-Tick Final Pre-Send Hard Gate (Stream C — #76)."""

from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import v6_autolot_broker_presend_gate as gate


def _snap(**overrides):
    base = {
        "accountLogin": 100362,
        "accountCurrency": "USD",
        "equity": 10000.0,
        "freeMargin": 8000.0,
        "dailyRealizedAndUnrealizedPnlUsd": -25.0,
        "bid": 2650.0,
        "ask": 2650.25,
        "quoteTimestampUtc": 1795417000,
        "maxQuoteAgeSeconds": 5,
        "volumeMin": 0.01,
        "volumeMax": 10.0,
        "volumeStep": 0.01,
        "contractSize": 100.0,
        "orderCalcProfitLossOneLotUsd": 700.0,
        "orderCalcMarginOneLotUsd": 2650.0,
        "commissionPerLotUsd": 7.0,
        "estimatedSlippageUsdPerOz": 0.25,
        "tradingSessionOpen": True,
    }
    base.update(overrides)
    return base


def _policy(**overrides):
    base = {
        "maxRiskPerTradePct": 1.0,
        "maxTotalAccountRiskPct": 3.0,
        "maxDailyLossPct": 3.0,
        "maxOpenPositions": 3,
        "maxLotPerOrder": 1.0,
        "minFreeMarginBufferRatio": 1.2,
    }
    base.update(overrides)
    return base


class TestSameTickPreSendAutoLotGate(unittest.TestCase):
    def test_admits_only_when_estop_clear_and_all_broker_specs_fresh(self) -> None:
        res = gate.evaluate_same_tick_presend_autolot_gate(
            requested_mode="AUTO_LOT",
            auto_lot_owner_approved=True,
            fixed_lot=0.01,
            side="BUY",
            entry_price=2650.25,
            stop_loss_price=2643.25,
            broker_snapshot=_snap(),
            risk_policy=_policy(),
            now_utc=1795417002,
            emergency_stop_active=False,
        )
        self.assertTrue(res["admitted"])
        self.assertEqual(res["effectiveLot"], 0.13)
        self.assertFalse(res["liveAuthorized"])

    def test_missing_order_calc_profit_or_stale_tick_or_estop_blocks(self) -> None:
        no_calc = gate.evaluate_same_tick_presend_autolot_gate(
            requested_mode="AUTO_LOT",
            auto_lot_owner_approved=True,
            fixed_lot=0.01,
            side="BUY",
            entry_price=2650.25,
            stop_loss_price=2643.25,
            broker_snapshot=_snap(orderCalcProfitLossOneLotUsd=None),
            risk_policy=_policy(),
            now_utc=1795417002,
            emergency_stop_active=False,
        )
        self.assertFalse(no_calc["admitted"])
        self.assertIn("ORDER_CALC_PROFIT_UNVERIFIED", no_calc["hardBlocks"])

        stale = gate.evaluate_same_tick_presend_autolot_gate(
            requested_mode="AUTO_LOT",
            auto_lot_owner_approved=True,
            fixed_lot=0.01,
            side="BUY",
            entry_price=2650.25,
            stop_loss_price=2643.25,
            broker_snapshot=_snap(),
            risk_policy=_policy(),
            now_utc=1795417010,
            emergency_stop_active=True,
        )
        self.assertFalse(stale["admitted"])
        self.assertIn("SAME_TICK_QUOTE_STALE", stale["hardBlocks"])
        self.assertIn("EMERGENCY_STOP_ACTIVE_FAIL_CLOSED", stale["hardBlocks"])

    def test_daily_loss_hard_stop_and_non_usd_currency_block(self) -> None:
        daily = gate.evaluate_same_tick_presend_autolot_gate(
            requested_mode="FIXED_LOT",
            auto_lot_owner_approved=False,
            fixed_lot=0.01,
            side="SELL",
            entry_price=2650.0,
            stop_loss_price=2657.0,
            broker_snapshot=_snap(dailyRealizedAndUnrealizedPnlUsd=-300.0, accountCurrency="EUR"),
            risk_policy=_policy(),
            now_utc=1795417002,
            emergency_stop_active=False,
        )
        self.assertFalse(daily["admitted"])
        self.assertIn("HARD_DAILY_LOSS_STOP_ACTIVE", daily["hardBlocks"])
        self.assertIn("UNVERIFIED_OR_NON_USD_ACCOUNT_CURRENCY", daily["hardBlocks"])


if __name__ == "__main__":
    unittest.main()
