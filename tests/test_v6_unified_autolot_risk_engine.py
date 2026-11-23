"""Unit tests for Unified V6 Auto Lot, Risk Cap & MT5 Spec Engine (Stream C — #76)."""

from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import v6_unified_autolot_risk_engine as eng


def _account(**overrides):
    base = {
        "equity": 10000.0,
        "freeMargin": 8000.0,
        "dailyRealizedAndUnrealizedPnlUsd": -50.0,
        "marginMode": "HEDGING",
    }
    base.update(overrides)
    return base


def _spec(**overrides):
    base = {
        "bid": 2650.00,
        "ask": 2650.25,
        "quoteTimestampUtc": 1795414000,
        "maxQuoteAgeSeconds": 15,
        "contractSize": 100.0,
        "volumeMin": 0.01,
        "volumeMax": 10.0,
        "volumeStep": 0.01,
        "orderCalcLossPerOneLotUsd": 700.0,
        "marginRequiredPerOneLotUsd": 2650.0,
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
        "maxDcaLayers": 2,
        "maxLotPerOrder": 1.0,
        "minFreeMarginBufferRatio": 1.2,
    }
    base.update(overrides)
    return base


class TestUnifiedAutoLotRiskEngine(unittest.TestCase):
    def test_auto_lot_requires_explicit_owner_approval(self) -> None:
        res = eng.evaluate_unified_autolot_and_risk(
            requested_mode="AUTO_LOT",
            auto_lot_owner_approved=False,
            fixed_lot=0.01,
            direction="BUY",
            entry_price=2650.25,
            stop_loss_price=2643.25,
            account=_account(),
            broker_spec=_spec(),
            risk_policy=_policy(),
            now_utc=1795414005,
        )
        self.assertFalse(res["allowed"])
        self.assertIn("AUTO_LOT_REQUIRES_EXPLICIT_OWNER_APPROVAL", res["hardBlocks"])
        self.assertFalse(res["liveAuthorized"])

    def test_auto_lot_floors_to_volume_step_for_buy_and_sell(self) -> None:
        res_buy = eng.evaluate_unified_autolot_and_risk(
            requested_mode="AUTO_LOT",
            auto_lot_owner_approved=True,
            fixed_lot=0.01,
            direction="BUY",
            entry_price=2650.25,
            stop_loss_price=2643.25,
            account=_account(),
            broker_spec=_spec(),
            risk_policy=_policy(),
            now_utc=1795414005,
        )
        self.assertTrue(res_buy["allowed"])
        self.assertEqual(res_buy["effectiveLot"], 0.13)
        self.assertLessEqual(res_buy["estimatedOrderRiskUsd"], 100.0)
        self.assertFalse(res_buy["liveAuthorized"])

        res_sell = eng.evaluate_unified_autolot_and_risk(
            requested_mode="AUTO_LOT",
            auto_lot_owner_approved=True,
            fixed_lot=0.01,
            direction="SELL",
            entry_price=2650.00,
            stop_loss_price=2657.00,
            account=_account(),
            broker_spec=_spec(),
            risk_policy=_policy(),
            now_utc=1795414005,
        )
        self.assertTrue(res_sell["allowed"])
        self.assertEqual(res_sell["effectiveLot"], 0.13)

    def test_small_equity_never_rounds_up_to_volume_min(self) -> None:
        res = eng.evaluate_unified_autolot_and_risk(
            requested_mode="AUTO_LOT",
            auto_lot_owner_approved=True,
            fixed_lot=0.01,
            direction="BUY",
            entry_price=2650.25,
            stop_loss_price=2643.25,
            account=_account(equity=500.0, freeMargin=400.0, dailyRealizedAndUnrealizedPnlUsd=0.0),
            broker_spec=_spec(),
            risk_policy=_policy(),
            now_utc=1795414005,
        )
        self.assertFalse(res["allowed"])
        self.assertEqual(res["effectiveLot"], 0.0)
        self.assertIn("AUTO_LOT_BELOW_VOLUME_MIN_EXCEEDS_RISK_BUDGET", res["hardBlocks"])

    def test_hard_daily_loss_and_insufficient_margin_and_stale_quote_block(self) -> None:
        res_daily = eng.evaluate_unified_autolot_and_risk(
            requested_mode="AUTO_LOT",
            auto_lot_owner_approved=True,
            fixed_lot=0.01,
            direction="BUY",
            entry_price=2650.25,
            stop_loss_price=2643.25,
            account=_account(dailyRealizedAndUnrealizedPnlUsd=-300.0),
            broker_spec=_spec(),
            risk_policy=_policy(),
            now_utc=1795414005,
        )
        self.assertFalse(res_daily["allowed"])
        self.assertIn("HARD_DAILY_LOSS_LIMIT_REACHED", res_daily["hardBlocks"])

        res_margin = eng.evaluate_unified_autolot_and_risk(
            requested_mode="AUTO_LOT",
            auto_lot_owner_approved=True,
            fixed_lot=0.01,
            direction="BUY",
            entry_price=2650.25,
            stop_loss_price=2643.25,
            account=_account(freeMargin=100.0),
            broker_spec=_spec(),
            risk_policy=_policy(),
            now_utc=1795414005,
        )
        self.assertFalse(res_margin["allowed"])
        self.assertIn("INSUFFICIENT_FREE_MARGIN", res_margin["hardBlocks"])

        res_stale = eng.evaluate_unified_autolot_and_risk(
            requested_mode="AUTO_LOT",
            auto_lot_owner_approved=True,
            fixed_lot=0.01,
            direction="BUY",
            entry_price=2650.25,
            stop_loss_price=2643.25,
            account=_account(),
            broker_spec=_spec(quoteTimestampUtc=1795413900),
            risk_policy=_policy(),
            now_utc=1795414005,
        )
        self.assertFalse(res_stale["allowed"])
        self.assertIn("QUOTE_STALE_FAIL_CLOSED", res_stale["hardBlocks"])

    def test_dca_and_total_exposure_and_netting_warning(self) -> None:
        open_pos = [{"riskUsd": 150.0, "isDca": True}, {"riskUsd": 120.0, "isDca": True}]
        res_dca = eng.evaluate_unified_autolot_and_risk(
            requested_mode="AUTO_LOT",
            auto_lot_owner_approved=True,
            fixed_lot=0.01,
            direction="BUY",
            entry_price=2650.25,
            stop_loss_price=2643.25,
            account=_account(marginMode="NETTING"),
            broker_spec=_spec(),
            risk_policy=_policy(maxDcaLayers=2),
            open_positions=open_pos,
            now_utc=1795414005,
            is_dca_entry=True,
        )
        self.assertFalse(res_dca["allowed"])
        self.assertIn("MAX_DCA_LAYERS_LIMIT_REACHED", res_dca["hardBlocks"])
        self.assertIn("NETTING_ACCOUNT_COMBINES_DCA_INTO_SINGLE_POSITION", res_dca["warnings"])

    def test_missing_or_invalid_broker_loss_never_uses_contract_distance_fallback(self) -> None:
        for raw_loss in (None, 0.0, float("nan"), float("inf"), -1.0, False):
            with self.subTest(loss=repr(raw_loss)):
                result = eng.evaluate_unified_autolot_and_risk(
                    requested_mode="AUTO_LOT",
                    auto_lot_owner_approved=True,
                    fixed_lot=0.01,
                    direction="BUY",
                    entry_price=2650.25,
                    stop_loss_price=2643.25,
                    account=_account(),
                    broker_spec=_spec(orderCalcLossPerOneLotUsd=raw_loss),
                    risk_policy=_policy(),
                    now_utc=1795414005,
                )
                self.assertFalse(result["allowed"])
                self.assertEqual(result["effectiveLot"], 0.0)
                self.assertIn(
                    "BROKER_ORDER_CALC_PROFIT_LOSS_UNVERIFIED", result["hardBlocks"]
                )
                self.assertFalse(result["liveAuthorized"])

    def test_missing_cost_model_and_inverted_broker_volume_range_block(self) -> None:
        for spec in (
            _spec(commissionPerLotUsd=None),
            _spec(estimatedSlippageUsdPerOz=None),
            _spec(volumeMin=2.0, volumeMax=1.0),
        ):
            with self.subTest(spec=repr(spec)):
                result = eng.evaluate_unified_autolot_and_risk(
                    requested_mode="AUTO_LOT",
                    auto_lot_owner_approved=True,
                    fixed_lot=0.01,
                    direction="SELL",
                    entry_price=2650.0,
                    stop_loss_price=2657.0,
                    account=_account(),
                    broker_spec=spec,
                    risk_policy=_policy(),
                    now_utc=1795414005,
                )
                self.assertFalse(result["allowed"])
                self.assertFalse(result["runtimePreSendIntegrated"])
                self.assertEqual(
                    result["evaluationScope"],
                    "OFFLINE_ONLY_NOT_WIRED_TO_FINAL_MT5_ORDER_SEND",
                )

    def test_candidate_allowed_not_equivalent_to_live_approval_or_broker_verification(self) -> None:
        result = eng.evaluate_unified_autolot_and_risk(
            requested_mode="AUTO_LOT",
            auto_lot_owner_approved=True,
            fixed_lot=0.01,
            direction="BUY",
            entry_price=2650.25,
            stop_loss_price=2643.25,
            account=_account(),
            broker_spec=_spec(),
            risk_policy=_policy(),
            now_utc=1795414005,
        )
        self.assertTrue(result["allowed"])
        self.assertFalse(result["runtimePreSendIntegrated"])
        self.assertFalse(result["brokerPricingProvenanceVerified"])
        self.assertFalse(result["liveAuthorized"])

    def test_shadow_mode_computes_auto_lot_without_changing_fixed_execution_lot(self) -> None:
        res = eng.evaluate_unified_autolot_and_risk(
            requested_mode="SHADOW",
            auto_lot_owner_approved=False,
            fixed_lot=0.02,
            direction="BUY",
            entry_price=2650.25,
            stop_loss_price=2643.25,
            account=_account(),
            broker_spec=_spec(),
            risk_policy=_policy(),
            now_utc=1795414005,
        )
        self.assertTrue(res["allowed"])
        self.assertEqual(res["computedAutoLot"], 0.13)
        self.assertEqual(res["effectiveLot"], 0.02)


if __name__ == "__main__":
    unittest.main()
