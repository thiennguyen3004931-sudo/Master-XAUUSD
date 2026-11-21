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
        mult = 100000.0 if symbol == "EURUSD" else 100.0
        pnl = (stop - entry) if order_type == self.ORDER_TYPE_BUY else (entry - stop)
        return pnl * lot * mult

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
                self.assertEqual(res["metadataTrustBoundary"], "CALLER_SUPPLIED_METADATA_NOT_CRYPTOGRAPHIC_AUTHENTICITY")
                self.assertIn("candidateMetadata", res)

    def test_profitable_trailing_sl_counts_mark_to_stop_equity_drawdown_for_buy_sell_multi_and_foreign(self):
        buy_trailing = [
            {"symbol": "XAUUSD.G", "side": "BUY", "volume": 0.02, "price_open": 3980.0, "sl": 3990.0, "mark_price": 4000.0}
        ]
        res_buy = evaluate_auto_lot_candidate_from_snapshot(**make_kwargs(broker_positions=buy_trailing))
        self.assertTrue(res_buy["ok"], res_buy)
        self.assertEqual(res_buy["openRiskToOriginalCostUsd"], 0.0)
        self.assertAlmostEqual(res_buy["openMarkToStopEquityDrawdownUsd"], 21.0, places=4)

        multi_positions = [
            {"symbol": "XAUUSD.G", "side": "SELL", "volume": 0.01, "price_open": 4020.0, "sl": 4010.0, "mark_price": 4000.0},
            {"symbol": "EURUSD", "side": "BUY", "volume": 0.05, "price_open": 1.1000, "sl": 1.0950, "mark_price": 1.1020},
        ]
        res_multi = evaluate_auto_lot_candidate_from_snapshot(**make_kwargs(broker_positions=multi_positions))
        self.assertTrue(res_multi["ok"], res_multi)
        self.assertGreater(res_multi["openMarkToStopEquityDrawdownUsd"], 45.0)
        self.assertLess(res_multi["candidateVolume"], 0.04)

    def test_missing_or_invalid_mark_price_on_open_position_fails_closed(self):
        missing_mark = [{"symbol": "XAUUSD.G", "side": "BUY", "volume": 0.02, "price_open": 3980.0, "sl": 3990.0}]
        res_missing = evaluate_auto_lot_candidate_from_snapshot(**make_kwargs(broker_positions=missing_mark))
        self.assertEqual(res_missing["decision"], "NO_TRADE")
        self.assertEqual(res_missing["status"], "BLOCKED_OPEN_EXPOSURE_UNVERIFIED")

        bad_mark = [{"symbol": "XAUUSD.G", "side": "BUY", "volume": 0.02, "price_open": 3980.0, "sl": 3990.0, "mark_price": 3989.0}]
        res_bad = evaluate_auto_lot_candidate_from_snapshot(**make_kwargs(broker_positions=bad_mark))
        self.assertEqual(res_bad["decision"], "NO_TRADE")
        self.assertEqual(res_bad["status"], "BLOCKED_OPEN_EXPOSURE_UNVERIFIED")

    def test_reprice_rejects_mismatched_metadata_and_dca_transition(self):
        kw = make_kwargs()
        initial = evaluate_auto_lot_candidate_from_snapshot(**kw)
        self.assertTrue(initial["ok"])
        reprice_kw = dict(kw)
        reprice_kw["fresh_quote"] = reprice_kw.pop("quote")

        bad_flag = dict(initial, executionEnabled=True)
        self.assertEqual(reprice_auto_lot_before_send(initial_candidate=bad_flag, **reprice_kw)["status"], "BLOCKED_UNSUPPORTED_EXECUTION_FLAG")

        no_meta = dict(initial)
        no_meta.pop("candidateMetadata", None)
        self.assertEqual(reprice_auto_lot_before_send(initial_candidate=no_meta, **reprice_kw)["status"], "BLOCKED_CANDIDATE_METADATA_MISSING")

        for field, val in (("side", "SELL"), ("expected_account_login", 999999), ("symbol", "EURUSD")):
            bad_kw = dict(reprice_kw, **{field: val})
            self.assertEqual(reprice_auto_lot_before_send(initial_candidate=initial, **bad_kw)["status"], "BLOCKED_CANDIDATE_METADATA_MISMATCH")

        self.assertEqual(reprice_auto_lot_before_send(initial_candidate=initial, dca_layer=True, **reprice_kw)["status"], "BLOCKED_DCA_POLICY_UNVERIFIED")

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
