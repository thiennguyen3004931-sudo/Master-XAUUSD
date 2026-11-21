"""Offline tests for G2 Auto Risk Lot snapshot evaluator & shadow repricer (#76)."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.v6_auto_lot_reprice_evaluator import (
    evaluate_auto_lot_candidate_from_snapshot,
    reprice_auto_lot_before_send,
)


class MockBroker:
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1

    def __init__(self):
        self.min_vol = 0.01
        self.step = 0.01
        self.max_vol = 50.0
        self.point = 0.01
        self.symbol_name = "XAUUSD.G"

    def symbol_info(self, symbol):
        return SimpleNamespace(
            name=self.symbol_name,
            point=self.point,
            volume_min=self.min_vol,
            volume_step=self.step,
            volume_max=self.max_vol,
        )

    def order_calc_profit(self, order_type, symbol, lot, entry, stop):
        pnl = (stop - entry) if order_type == self.ORDER_TYPE_BUY else (entry - stop)
        return pnl * lot * 100.0

    def order_calc_margin(self, order_type, symbol, lot, entry):
        return lot * entry

    def order_send(self, *args, **kwargs):
        raise AssertionError("G2 shadow evaluator must never call order_send")


def make_account(**kw):
    base = dict(login=123456, server="DBGMarkets-Live", equity=4000.0, margin_free=4000.0)
    base.update(kw)
    return SimpleNamespace(**base)


def make_kwargs(side="BUY", **overrides):
    now = 1700000100.0
    quote = {"bid": 4000.00, "ask": 4000.25, "timestampUtc": now - 2.0}
    stop = 3993.25 if side == "BUY" else 4007.00
    base = dict(
        broker=MockBroker(),
        account=make_account(),
        expected_account_login=123456,
        expected_server="DBGMarkets-Live",
        symbol="XAUUSD.G",
        side=side,
        quote=quote,
        now_utc=now,
        stop_loss_price=stop,
        risk_percent=0.8,
        broker_positions=[],
        broker_pending_orders=[],
        daily_remaining_risk_usd=100.0,
        commission_usd_per_lot=7.0,
        slippage_usd_per_lot=3.0,
    )
    base.update(overrides)
    return base


class AutoLotRepriceEvaluatorTests(unittest.TestCase):
    def test_buy_and_sell_snapshot_evaluation_stays_shadow_only(self):
        for side in ("BUY", "SELL"):
            with self.subTest(side=side):
                res = evaluate_auto_lot_candidate_from_snapshot(**make_kwargs(side=side))
                self.assertTrue(res["ok"], res)
                self.assertEqual(res["decision"], "SHADOW_CANDIDATE_ONLY")
                self.assertFalse(res["executionEnabled"])
                self.assertFalse(res["runtimePreSendAccepted"])
                self.assertEqual(res["candidateVolume"], 0.04)
                self.assertEqual(res["spreadPoints"], 25.0)
                self.assertIn("candidateFingerprint", res)

    def test_small_balance_and_zero_cost_unverified_return_hard_no_trade(self):
        res = evaluate_auto_lot_candidate_from_snapshot(
            **make_kwargs(account=make_account(equity=150.0, margin_free=150.0))
        )
        self.assertEqual(res["decision"], "NO_TRADE")
        self.assertEqual(res["status"], "BLOCKED_MIN_LOT_EXCEEDS_RISK_OR_MARGIN")

        zero_cost = evaluate_auto_lot_candidate_from_snapshot(
            **make_kwargs(commission_usd_per_lot=0.0, slippage_usd_per_lot=0.0)
        )
        self.assertEqual(zero_cost["decision"], "NO_TRADE")
        self.assertEqual(zero_cost["status"], "BLOCKED_COST_UNVERIFIED")

    def test_profitable_trailing_sl_on_open_position_has_zero_adverse_risk(self):
        trailing_profit_pos = [{"symbol": "XAUUSD.G", "side": "BUY", "volume": 0.05, "price_open": 3980.0, "sl": 3990.0}]
        res = evaluate_auto_lot_candidate_from_snapshot(**make_kwargs(broker_positions=trailing_profit_pos))
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["openRiskUsd"], 0.0)

        bad_pending = [{"symbol": "XAUUSD.G", "side": "BUY", "volume": 0.02, "price_open": 4005.0, "sl": 4010.0}]
        blocked = evaluate_auto_lot_candidate_from_snapshot(**make_kwargs(broker_pending_orders=bad_pending))
        self.assertEqual(blocked["decision"], "NO_TRADE")
        self.assertEqual(blocked["status"], "BLOCKED_PENDING_EXPOSURE_UNVERIFIED")

    def test_reprice_rejects_forged_or_mismatched_provenance_and_dca_transition(self):
        kw = make_kwargs()
        initial = evaluate_auto_lot_candidate_from_snapshot(**kw)
        self.assertTrue(initial["ok"])
        reprice_kw = dict(kw)
        reprice_kw["fresh_quote"] = reprice_kw.pop("quote")

        forged = dict(initial, executionEnabled=True)
        res_forged = reprice_auto_lot_before_send(initial_candidate=forged, **reprice_kw)
        self.assertEqual(res_forged["decision"], "NO_TRADE")
        self.assertEqual(res_forged["status"], "BLOCKED_FORGED_EXECUTION_FLAG")

        no_fp = dict(initial)
        no_fp.pop("candidateFingerprint", None)
        res_no_fp = reprice_auto_lot_before_send(initial_candidate=no_fp, **reprice_kw)
        self.assertEqual(res_no_fp["status"], "BLOCKED_CANDIDATE_PROVENANCE_UNVERIFIED")

        for field, val in (("side", "SELL"), ("expected_account_login", 999999), ("symbol", "EURUSD")):
            bad_kw = dict(reprice_kw, **{field: val})
            res_mismatch = reprice_auto_lot_before_send(initial_candidate=initial, **bad_kw)
            self.assertEqual(res_mismatch["decision"], "NO_TRADE")
            self.assertEqual(res_mismatch["status"], "BLOCKED_CANDIDATE_PROVENANCE_MISMATCH")

        res_dca = reprice_auto_lot_before_send(initial_candidate=initial, dca_layer=True, **reprice_kw)
        self.assertEqual(res_dca["decision"], "NO_TRADE")
        self.assertEqual(res_dca["status"], "BLOCKED_DCA_POLICY_UNVERIFIED")

    def test_reprice_realigns_to_fresh_broker_step_and_blocks_if_below_min(self):
        kw = make_kwargs(risk_percent=0.6)
        initial = evaluate_auto_lot_candidate_from_snapshot(**kw)
        self.assertTrue(initial["ok"], initial)
        self.assertEqual(initial["candidateVolume"], 0.03)

        fresh_broker = MockBroker()
        fresh_broker.step = 0.02
        fresh_broker.min_vol = 0.02
        reprice_kw = dict(kw, broker=fresh_broker, risk_percent=0.6)
        reprice_kw["fresh_quote"] = reprice_kw.pop("quote")
        reprice_kw["account"] = make_account(equity=6000.0, margin_free=6000.0)
        aligned = reprice_auto_lot_before_send(initial_candidate=initial, **reprice_kw)
        self.assertTrue(aligned["ok"], aligned)
        self.assertEqual(aligned["candidateVolume"], 0.02)

        fresh_broker.min_vol = 0.04
        below_min = reprice_auto_lot_before_send(initial_candidate=initial, **reprice_kw)
        self.assertEqual(below_min["decision"], "NO_TRADE")
        self.assertEqual(below_min["status"], "BLOCKED_REPRICED_VOLUME_BELOW_BROKER_MIN")


if __name__ == "__main__":
    unittest.main()
