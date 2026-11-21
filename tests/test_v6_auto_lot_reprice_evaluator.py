"""Offline tests for G2 Auto Risk Lot snapshot evaluator & pre-send repricer (#76)."""
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
                self.assertEqual(res["candidateVolume"], 0.04)
                self.assertEqual(res["spreadPoints"], 25.0)

    def test_small_balance_returns_hard_no_trade(self):
        res = evaluate_auto_lot_candidate_from_snapshot(**make_kwargs(account=make_account(equity=150.0, margin_free=150.0)))
        self.assertFalse(res["ok"])
        self.assertEqual(res["decision"], "NO_TRADE")
        self.assertEqual(res["status"], "BLOCKED_MIN_LOT_EXCEEDS_RISK_OR_MARGIN")
        self.assertIsNone(res["candidateVolume"])

    def test_account_switch_or_restart_mismatch_returns_no_trade(self):
        res = evaluate_auto_lot_candidate_from_snapshot(**make_kwargs(account=make_account(login=999999)))
        self.assertEqual(res["decision"], "NO_TRADE")
        self.assertEqual(res["status"], "BLOCKED_ACCOUNT_SERVER_MISMATCH")
        res_srv = evaluate_auto_lot_candidate_from_snapshot(**make_kwargs(account=make_account(server="Other-Server")))
        self.assertEqual(res_srv["decision"], "NO_TRADE")
        self.assertEqual(res_srv["status"], "BLOCKED_ACCOUNT_SERVER_MISMATCH")

    def test_stale_quote_and_spread_jump_return_no_trade(self):
        stale = evaluate_auto_lot_candidate_from_snapshot(
            **make_kwargs(quote={"bid": 4000.00, "ask": 4000.25, "timestampUtc": 1700000000.0})
        )
        self.assertEqual(stale["decision"], "NO_TRADE")
        self.assertEqual(stale["status"], "BLOCKED_QUOTE_STALE")
        spread_jump = evaluate_auto_lot_candidate_from_snapshot(
            **make_kwargs(quote={"bid": 4000.00, "ask": 4001.20, "timestampUtc": 1700000099.0})
        )
        self.assertEqual(spread_jump["decision"], "NO_TRADE")
        self.assertEqual(spread_jump["status"], "BLOCKED_SPREAD_JUMP")

    def test_combined_open_and_pending_exposure_reduces_or_blocks_lot(self):
        open_pos = [{"symbol": "XAUUSD.G", "side": "BUY", "volume": 0.03, "price_open": 4000.0, "sl": 3993.0}]
        pending = [{"symbol": "XAUUSD.G", "side": "SELL", "volume": 0.03, "price_open": 4005.0, "sl": 4012.0}]
        res = evaluate_auto_lot_candidate_from_snapshot(
            **make_kwargs(broker_positions=open_pos, broker_pending_orders=pending)
        )
        self.assertTrue(res["ok"], res)
        self.assertLess(res["candidateVolume"], 0.04)
        self.assertGreater(res["combinedExistingRiskUsd"], 40.0)
        bad_pending = [{"symbol": "XAUUSD.G", "side": "SELL", "volume": 0.02, "price_open": 4005.0, "sl": 0.0}]
        blocked = evaluate_auto_lot_candidate_from_snapshot(**make_kwargs(broker_pending_orders=bad_pending))
        self.assertEqual(blocked["decision"], "NO_TRADE")
        self.assertEqual(blocked["status"], "BLOCKED_PENDING_EXPOSURE_UNVERIFIED")

    def test_pre_send_reprice_shrinks_on_adverse_move_and_blocks_partial_fill(self):
        kw = make_kwargs()
        initial = evaluate_auto_lot_candidate_from_snapshot(**kw)
        self.assertTrue(initial["ok"])
        self.assertEqual(initial["candidateVolume"], 0.04)
        reprice_kw = dict(kw)
        reprice_kw["fresh_quote"] = reprice_kw.pop("quote")
        reprice_kw["account"] = make_account(equity=2000.0, margin_free=2000.0)
        repriced = reprice_auto_lot_before_send(initial_candidate=initial, **reprice_kw)
        self.assertTrue(repriced["ok"], repriced)
        self.assertTrue(repriced["volumeReducedOnReprice"])
        self.assertLess(repriced["candidateVolume"], initial["candidateVolume"])
        self.assertFalse(repriced["executionEnabled"])
        partial = reprice_auto_lot_before_send(
            initial_candidate=initial, partial_fill_existing_volume=0.02, **reprice_kw
        )
        self.assertEqual(partial["decision"], "NO_TRADE")
        self.assertEqual(partial["status"], "BLOCKED_PARTIAL_FILL_RECONCILIATION_REQUIRED")


if __name__ == "__main__":
    unittest.main()
