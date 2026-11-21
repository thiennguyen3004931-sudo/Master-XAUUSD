"""Offline fail-closed tests for G2 P1 NON-AUTHORIZING shadow risk (#76)."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.v6_auto_lot_shadow_contract import (
    compute_entry_risk_usd,
    evaluate_all_symbol_worst_case_exposure,
    evaluate_shadow_auto_lot_p1,
    evaluate_trusted_clock_and_auth,
)


def mock_broker_profit(side, symbol, volume, entry, stop):
    """Scenario calculator only; never claimed as broker-attested."""
    units = {"XAUUSD": 100.0, "EURUSD": 100000.0, "GBPUSD": 100000.0}[symbol]
    move = entry - stop if side == "BUY" else stop - entry
    return -move * volume * units


def _base_kwargs():
    return {
        "snapshot_epoch_utc": 1700000000,
        "now_utc": 1700000002,
        "expected_account_login": 1001,
        "expected_server": "Broker-Demo",
        "observed_account_login": 1001,
        "observed_server": "Broker-Demo",
        "broker_contract_attested": True,
        "equity_usd": 10000.0,
        "max_total_risk_pct": 0.02,
        "candidate_side": "BUY",
        "candidate_symbol": "XAUUSD",
        "candidate_entry_price": 2600.0,
        "candidate_stop_loss": 2590.0,
        "tick_size": 0.01,
        "tick_value": 1.0,
        "volume_min": 0.01,
        "volume_max": 5.0,
        "volume_step": 0.01,
        "commission_per_lot_rt": 7.0,
        "slippage_ticks": 10.0,
        "positions": [],
        "pending_orders": [],
        "broker_profit_calculator": mock_broker_profit,
    }


def _pending(*, kind=6, **extra):
    row = {
        "ticket": 22,
        "symbol": "XAUUSD",
        "type": kind,
        "priceOpen": 2610.0,
        "stopLimitPrice": 2605.0,
        "sl": 2600.0,
        "volume": 0.1,
        "tickSize": 0.01,
        "tickValue": 1.0,
        "commissionPerLotRt": 7.0,
    }
    row.update(extra)
    return row


def _position(**extra):
    row = {
        "ticket": 11,
        "symbol": "EURUSD",
        "type": 0,
        "priceOpen": 1.1000,
        "markPrice": 1.1010,
        "sl": 1.0960,
        "volume": 0.1,
        "tickSize": 0.0001,
        "tickValue": 1.0,
        "commissionPerLotRt": 0.0,
        "swap": -2.0,
    }
    row.update(extra)
    return row


class AutoLotShadowContractP1Tests(unittest.TestCase):
    def assert_never_authorizes(self, result):
        self.assertTrue(result["shadowOnly"])
        self.assertFalse(result["executionEnabled"])
        self.assertFalse(result["runtimePreSendAccepted"])
        self.assertFalse(result["liveAuthorized"])
        self.assertFalse(result["admitted"])
        self.assertEqual(result["recommendedLot"], 0.0)
        self.assertFalse(result["brokerContractIndependentlyVerified"])
        self.assertFalse(result["brokerCostIndependentlyVerified"])
        self.assertEqual(result["activeSizingMode"], "FIXED_LOT")

    def test_all_symbol_risk_and_stop_limit_remain_shadow_only(self):
        kw = _base_kwargs()
        kw["positions"] = [_position()]
        kw["pending_orders"] = [_pending()]
        result = evaluate_shadow_auto_lot_p1(**kw)
        self.assert_never_authorizes(result)
        self.assertTrue(result["shadowCandidateAvailable"])
        self.assertEqual(result["reason"], "UNVERIFIED_SHADOW_CANDIDATE_ONLY")
        self.assertEqual(result["symbolsIncluded"], ["EURUSD", "XAUUSD"])
        self.assertGreater(result["shadowEstimatedLot"], 0.0)
        self.assertLess(result["shadowEstimatedLot"], 0.20)
        self.assertGreater(result["candidateRiskUsd"], 0.0)

    def test_unverified_account_clock_inventory_and_contract_fail_closed(self):
        for changed, expected in (
            ({"broker_contract_attested": False}, "BROKER_CONTRACT_CLAIM_MISSING"),
            ({"now_utc": 1700000010}, "SNAPSHOT_STALE"),
            ({"now_utc": 1699999997}, "CLOCK_FUTURE_SKEW_EXCEEDED"),
            ({"positions": None}, "BROKER_INVENTORY_UNVERIFIED"),
            ({"pending_orders": None}, "BROKER_INVENTORY_UNVERIFIED"),
            ({"observed_account_login": 2002}, "ACCOUNT_BINDING_MISMATCH"),
            ({"observed_server": "Other-Server"}, "SERVER_BINDING_MISMATCH"),
            ({"broker_profit_calculator": None}, "BROKER_PRICING_UNAVAILABLE"),
            ({"max_total_risk_pct": 0.15}, "INVALID_EQUITY_OR_RISK_PCT"),
        ):
            with self.subTest(changed=changed):
                kw = _base_kwargs()
                kw.update(changed)
                res = evaluate_shadow_auto_lot_p1(**kw)
                self.assert_never_authorizes(res)
                self.assertFalse(res["shadowCandidateAvailable"])
                self.assertEqual(res["recommendedLot"], 0.0)
                self.assertEqual(res["reason"], expected)

    def test_side_and_stop_direction_fail_closed_for_buy_and_sell(self):
        for candidate_side, stop, expected in (
            ("BUY", 2600.0, "CANDIDATE_STOP_WRONG_SIDE_OR_NO_ADVERSE_GAP"),
            ("BUY", 2610.0, "CANDIDATE_STOP_WRONG_SIDE_OR_NO_ADVERSE_GAP"),
            ("SELL", 2590.0, "CANDIDATE_STOP_WRONG_SIDE_OR_NO_ADVERSE_GAP"),
            ("SHORT", 2610.0, "CANDIDATE_INVALID_SIDE_OR_SYMBOL"),
        ):
            with self.subTest(side=candidate_side, stop=stop):
                kw = _base_kwargs()
                kw["candidate_side"] = candidate_side
                kw["candidate_stop_loss"] = stop
                res = evaluate_shadow_auto_lot_p1(**kw)
                self.assert_never_authorizes(res)
                self.assertEqual(res["reason"], expected)
        kw = _base_kwargs()
        kw["candidate_side"] = "SELL"
        kw["candidate_stop_loss"] = 2610.0
        res = evaluate_shadow_auto_lot_p1(**kw)
        self.assert_never_authorizes(res)
        self.assertTrue(res["shadowCandidateAvailable"])

    def test_missing_or_invalid_stop_limit_secondary_and_direction_are_refused(self):
        for kind, changes, reason in (
            (6, {"stopLimitPrice": None}, "STOP_LIMIT_SECONDARY_PRICE_UNVERIFIED"),
            (6, {"stopLimitPrice": -1.0}, "STOP_LIMIT_SECONDARY_PRICE_UNVERIFIED"),
            (7, {"stopLimitPrice": 0.0}, "STOP_LIMIT_SECONDARY_PRICE_UNVERIFIED"),
            (6, {"sl": 2700.0}, "PENDING_STOP_WRONG_SIDE_OR_NO_ADVERSE_GAP"),
            (7, {"priceOpen": 2500.0, "stopLimitPrice": 2490.0, "sl": 2480.0},
             "PENDING_STOP_WRONG_SIDE_OR_NO_ADVERSE_GAP"),
        ):
            with self.subTest(kind=kind, changes=changes):
                kw = _base_kwargs()
                kw["pending_orders"] = [_pending(kind=kind, **changes)]
                res = evaluate_shadow_auto_lot_p1(**kw)
                self.assert_never_authorizes(res)
                self.assertEqual(res["reason"], reason)
        risk = evaluate_all_symbol_worst_case_exposure(
            positions=[], pending_orders=[_pending()],
            broker_profit_calculator=mock_broker_profit,
        )
        self.assertTrue(risk["ok"])
        # Conservative BUY STOP_LIMIT uses max(trigger 2610, limit 2605) = 2610.
        self.assertGreater(risk["pendingRiskUsd"], 100.0)

    def test_unknown_or_duplicate_inventory_records_fail_closed(self):
        for changed, expected in (
            ({"positions": [{"symbol": "XAUUSD"}]}, "INVALID_OR_DUPLICATE_POSITION_TICKET"),
            ({"positions": [_position(), _position()]}, "INVALID_OR_DUPLICATE_POSITION_TICKET"),
            ({"pending_orders": [_pending(), _pending()]}, "INVALID_OR_DUPLICATE_PENDING_TICKET"),
            ({"positions": [None]}, "INVALID_POSITION_RECORD"),
            ({"pending_orders": [None]}, "INVALID_PENDING_RECORD"),
            ({"pending_orders": [_pending(kind=99)]}, "UNKNOWN_PENDING_ORDER_TYPE"),
            ({"positions": [_position(markPrice=None)]}, "POSITION_INVALID_PRICE_SL_OR_VOLUME"),
            ({"positions": [_position(markPrice=1.095)]}, "POSITION_STOP_WRONG_SIDE_OR_NO_ADVERSE_GAP"),
            ({"positions": [_position(commissionPerLotRt=None)]}, "POSITION_INVALID_COST_PARAM"),
        ):
            with self.subTest(changed=changed):
                kw = _base_kwargs()
                kw.update(changed)
                res = evaluate_shadow_auto_lot_p1(**kw)
                self.assert_never_authorizes(res)
                self.assertEqual(res["reason"], expected)

    def test_broker_pricing_errors_are_not_replaced_with_linear_tick_shortcuts(self):
        cases = (
            (lambda *_: None, "CANDIDATE_BROKER_STOP_LOSS_NOT_VERIFIABLE"),
            (lambda *_: 100.0, "CANDIDATE_BROKER_STOP_LOSS_NOT_VERIFIABLE"),
            (lambda *_: float("nan"), "CANDIDATE_BROKER_STOP_LOSS_NOT_VERIFIABLE"),
            (lambda *_: (_ for _ in ()).throw(RuntimeError("read failed")), "CANDIDATE_BROKER_PRICING_EXCEPTION"),
        )
        for callback, reason in cases:
            with self.subTest(reason=reason):
                kw = _base_kwargs()
                kw["broker_profit_calculator"] = callback
                res = evaluate_shadow_auto_lot_p1(**kw)
                self.assert_never_authorizes(res)
                self.assertEqual(res["reason"], reason)

    def test_snapshot_clock_bounds_and_account_types_are_checked(self):
        base = {
            "snapshot_epoch_utc": 1700000000, "now_utc": 1700000002,
            "expected_account_login": 1001, "observed_account_login": 1001,
            "expected_server": "Broker-Demo", "observed_server": "Broker-Demo",
            "broker_contract_attested": True,
        }
        for changes, reason in (
            ({"max_snapshot_age_sec": -1}, "INVALID_FRESHNESS_BOUNDS"),
            ({"max_snapshot_age_sec": 0}, "INVALID_FRESHNESS_BOUNDS"),
            ({"max_future_skew_sec": -1}, "INVALID_FRESHNESS_BOUNDS"),
            ({"max_future_skew_sec": 100}, "INVALID_FRESHNESS_BOUNDS"),
            ({"expected_account_login": None}, "ACCOUNT_BINDING_MISMATCH"),
            ({"observed_account_login": True}, "ACCOUNT_BINDING_MISMATCH"),
            ({"broker_contract_attested": 1}, "BROKER_CONTRACT_CLAIM_MISSING"),
            ({"snapshot_epoch_utc": 10**1000}, "INVALID_CLOCK_TIMESTAMP"),
        ):
            with self.subTest(changes=changes):
                res = evaluate_trusted_clock_and_auth(**{**base, **changes})
                self.assertFalse(res["ok"])
                self.assertEqual(res["reason"], reason)

    def test_volume_grid_caps_floor_and_min_misalignment(self):
        kw = _base_kwargs()
        kw["volume_max"] = 0.055
        result = evaluate_shadow_auto_lot_p1(**kw)
        self.assert_never_authorizes(result)
        self.assertTrue(result["shadowCandidateAvailable"])
        self.assertEqual(result["shadowEstimatedLot"], 0.05)
        kw["volume_min"] = 0.015
        blocked = evaluate_shadow_auto_lot_p1(**kw)
        self.assert_never_authorizes(blocked)
        self.assertEqual(blocked["reason"], "INVALID_VOLUME_GRID")

    def test_final_reprice_rejects_nonlinear_increased_risk(self):
        def nonlinear(side, symbol, volume, entry, stop):
            base = mock_broker_profit(side, symbol, volume, entry, stop)
            return base * (2.0 if volume > 0.01 else 1.0)
        kw = _base_kwargs()
        kw["broker_profit_calculator"] = nonlinear
        res = evaluate_shadow_auto_lot_p1(**kw)
        self.assert_never_authorizes(res)
        self.assertEqual(res["reason"], "FINAL_BROKER_PRICED_RISK_UNVERIFIED_OR_OVER_BUDGET")

    def test_profit_calculator_uses_mark_to_stop_and_tracks_adverse_costs(self):
        risk = compute_entry_risk_usd(
            side="BUY", symbol="XAUUSD", entry_price=2600,
            stop_loss=2590, volume_lots=0.1, tick_size=0.01,
            tick_value=1.0, broker_profit_calculator=mock_broker_profit,
            commission_per_lot_rt=7, swap_usd=-3, slippage_ticks=10,
        )
        self.assertTrue(risk["ok"])
        self.assertAlmostEqual(risk["priceRiskUsd"], 100.0)
        self.assertAlmostEqual(risk["commissionUsd"], 0.7)
        self.assertAlmostEqual(risk["adverseSwapUsd"], 3.0)
        self.assertAlmostEqual(risk["slippageBufferUsd"], 1.0)
        self.assertAlmostEqual(risk["totalRiskUsd"], 104.7)
        self.assertFalse(risk["brokerProfitIndependentlyVerified"])


if __name__ == "__main__":
    unittest.main()
