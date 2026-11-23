"""Offline Auto Lot candidate screening is never live send authorization."""

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
        self.assertFalse(res["admitted"])
        self.assertEqual(res["effectiveLot"], 0.0)
        self.assertTrue(res["candidateEligibleOffline"])
        self.assertEqual(res["candidateLot"], 0.13)
        self.assertFalse(res["brokerPricingProvenanceVerified"])
        self.assertFalse(res["runtimeAdmissionVerified"])
        self.assertFalse(res["emergencyStopAuthorityVerified"])
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

    def test_broker_volume_grid_is_minimum_anchored_not_zero_anchored(self) -> None:
        for side, entry, sl in (
            ("BUY", 2650.25, 2643.25),
            ("SELL", 2650.0, 2657.0),
        ):
            with self.subTest(side=side):
                result = gate.evaluate_same_tick_presend_autolot_gate(
                    requested_mode="AUTO_LOT", auto_lot_owner_approved=True,
                    fixed_lot=0.03, side=side,
                    entry_price=entry, stop_loss_price=sl,
                    broker_snapshot=_snap(
                        volumeMin=0.03, volumeStep=0.02,
                        orderCalcProfitLossOneLotUsd=600.0,
                    ),
                    risk_policy=_policy(maxLotPerOrder=0.14),
                    now_utc=1795417002, emergency_stop_active=False,
                )
                self.assertTrue(result["candidateEligibleOffline"])
                self.assertFalse(result["admitted"])
                self.assertEqual(result["candidateLot"], 0.13)
                self.assertEqual(result["effectiveLot"], 0.0)
                self.assertFalse(result["liveAuthorized"])

    def test_fixed_and_shadow_never_silently_round_off_grid_sizes(self) -> None:
        broker = _snap(volumeMin=0.03, volumeStep=0.02, volumeMax=1.0)
        for mode in ("FIXED_LOT", "SHADOW"):
            for bad_lot in (0.01, 0.04, 0.06, 1.5):
                with self.subTest(mode=mode, lot=bad_lot):
                    report = gate.evaluate_same_tick_presend_autolot_gate(
                        requested_mode=mode, auto_lot_owner_approved=False,
                        fixed_lot=bad_lot, side="BUY",
                        entry_price=2650.25, stop_loss_price=2643.25,
                        broker_snapshot=broker, risk_policy=_policy(),
                        now_utc=1795417002, emergency_stop_active=False,
                    )
                    self.assertFalse(report["candidateEligibleOffline"])
                    self.assertEqual(report["candidateLot"], 0.0)
                    self.assertIn(
                        "FIXED_LOT_OUT_OF_GRID" if mode == "FIXED_LOT"
                        else "SHADOW_FIXED_LOT_OUT_OF_GRID",
                        report["hardBlocks"],
                    )
                    self.assertFalse(report["admitted"])

            valid = gate.evaluate_same_tick_presend_autolot_gate(
                requested_mode=mode, auto_lot_owner_approved=False,
                fixed_lot=0.05, side="BUY",
                entry_price=2650.25, stop_loss_price=2643.25,
                broker_snapshot=broker, risk_policy=_policy(),
                now_utc=1795417002, emergency_stop_active=False,
            )
            self.assertTrue(valid["candidateEligibleOffline"])
            self.assertEqual(valid["candidateLot"], 0.05)
            self.assertFalse(valid["admitted"])
            self.assertEqual(valid["candidateExecutionLotMode"], "FIXED_LOT")
            self.assertEqual(valid["advisoryAutoLotOnly"], mode == "SHADOW")
            self.assertFalse(valid["liveAuthorized"])

    def test_zero_broker_evidence_or_caller_stop_clear_never_admits_runtime(self) -> None:
        report = gate.evaluate_same_tick_presend_autolot_gate(
            requested_mode="AUTO_LOT", auto_lot_owner_approved=True,
            fixed_lot=0.03, side="BUY",
            entry_price=2650.25, stop_loss_price=2643.25,
            broker_snapshot=_snap(
                volumeMin=0.03, volumeStep=0.02,
                volumeMax=0.14,
                dailyRealizedAndUnrealizedPnlUsd=0.0,
            ),
            risk_policy=_policy(maxLotPerOrder=0.14),
            now_utc=1795417000, emergency_stop_active=False,
        )
        self.assertTrue(report["candidateEligibleOffline"])
        self.assertFalse(report["admitted"])
        self.assertFalse(report["runtimeAdmissionVerified"])
        self.assertFalse(report["brokerPricingProvenanceVerified"])
        self.assertFalse(report["brokerInventoryProvenanceVerified"])
        self.assertFalse(report["dailyPnlBrokerDayVerified"])
        self.assertFalse(report["emergencyStopAuthorityVerified"])
        self.assertFalse(report["liveAuthorized"])

    def test_precision_below_eight_decimals_refuses_broker_grid(self) -> None:
        result = gate.evaluate_same_tick_presend_autolot_gate(
            requested_mode="AUTO_LOT", auto_lot_owner_approved=True,
            fixed_lot=0.01, side="BUY",
            entry_price=2650.25, stop_loss_price=2643.25,
            broker_snapshot=_snap(
                volumeMin=0.000000001, volumeStep=0.000000001,
            ),
            risk_policy=_policy(),
            now_utc=1795417002, emergency_stop_active=False,
        )
        self.assertFalse(result["candidateEligibleOffline"])
        self.assertIn("BROKER_SYMBOL_SPEC_INVALID", result["hardBlocks"])
        self.assertFalse(result["admitted"])


if __name__ == "__main__":
    unittest.main()
