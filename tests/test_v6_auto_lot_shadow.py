"""Offline tests: shadow candidate never sends MT5 orders or arms LIVE."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from v6_auto_lot_shadow import recommend_broker_auto_lot_shadow


class MockBroker:
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1

    def __init__(self):
        self.sent = []
        self.min_vol = 0.01
        self.step = 0.01
        self.max_vol = 100
        self.broken = None
        self.profit_requests = []
        self.margin_requests = []

    def symbol_info(self, symbol):
        return SimpleNamespace(
            volume_min=self.min_vol, volume_step=self.step,
            volume_max=self.max_vol,
        )

    def order_calc_profit(self, side, symbol, lot, entry, stop):
        self.profit_requests.append((side, symbol, lot, entry, stop))
        if self.broken == "profit_error":
            raise RuntimeError("broker unavailable")
        if self.broken == "profit_nan":
            return float("nan")
        if self.broken == "profit_positive":
            return +1.0
        pnl = stop - entry if side == 0 else entry - stop
        return pnl * lot * 100.0

    def order_calc_margin(self, side, symbol, lot, entry):
        self.margin_requests.append((side, symbol, lot, entry))
        if self.broken == "margin_error":
            raise RuntimeError("broker margin unavailable")
        if self.broken == "margin_nan":
            return float("nan")
        if self.broken == "margin_none":
            return None
        return lot * entry

    def order_send(self, *args, **kwargs):
        raise AssertionError("Shadow sizing must never call order_send")


def assumptions(side="BUY", **overrides):
    entry = 4000.20 if side == "BUY" else 4000.00
    stop = entry - 6.8 if side == "BUY" else entry + 6.8
    kw = dict(
        quote_fresh=True, quote_age_seconds=2.0,
        risk_inputs_verified=True, costs_verified=True,
        existing_sl_risk_usd=0.0, pending_sl_risk_usd=0.0,
        daily_remaining_risk_usd=100.0, costs_usd_per_lot=10.0,
    )
    kw.update(overrides)
    return (entry, stop, kw)


class AutoLotShadowTest(unittest.TestCase):
    def account(self, **kw):
        defaults = dict(
            equity=4000.0, margin_free=4000.0,
            login=12345, server="MOCK-DEMO",
        )
        return SimpleNamespace(**{**defaults, **kw})

    def evaluate(self, broker=None, account=None, side="BUY", risk=0.8, **kwargs):
        entry, stop, extras = assumptions(side, **kwargs)
        broker = broker if broker is not None else MockBroker()
        account = account if account is not None else self.account()
        result = recommend_broker_auto_lot_shadow(
            broker, account, "XAUUSD.G", side, entry, stop, risk, **extras,
        )
        return result, broker

    def test_buy_and_sell_auto_lot_uses_broker_profit_and_step_round_down(self):
        for side in ("BUY", "SELL"):
            with self.subTest(side=side):
                result, broker = self.evaluate(side=side)
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["candidateVolume"], 0.04)
                self.assertFalse(result["executionEnabled"])
                self.assertEqual(result["mode"], "AUTO_RISK_PERCENT_SHADOW")
                self.assertLessEqual(result["estimatedAdverseSlLossWithCostUsd"],
                                     result["riskBudgetUsd"])
                self.assertGreaterEqual(len(broker.profit_requests), 2)
                self.assertEqual(broker.sent, [])

    def test_increased_broker_costs_reduce_lot_not_increase_risk(self):
        small, _ = self.evaluate(costs_usd_per_lot=10)
        larger, _ = self.evaluate(costs_usd_per_lot=200)
        self.assertTrue(small["ok"], small)
        self.assertTrue(larger["ok"], larger)
        self.assertLessEqual(larger["candidateVolume"], small["candidateVolume"])

    def test_round_down_on_custom_broker_volume_step(self):
        broker = MockBroker()
        broker.min_vol = 0.01
        broker.step = 0.01
        broker.max_vol = 0.035
        outcome, _ = self.evaluate(broker=broker)
        self.assertEqual(outcome["candidateVolume"], 0.03)

    def test_minimum_broker_lot_cannot_be_forced_above_budget(self):
        for mode in ("tiny_equity", "min_step", "margin_small"):
            with self.subTest(mode=mode):
                broker = MockBroker()
                if mode == "min_step":
                    broker.min_vol = 0.1
                    broker.step = 0.1
                account = (
                    self.account(equity=100.0) if mode == "tiny_equity"
                    else self.account(margin_free=1.0) if mode == "margin_small"
                    else self.account()
                )
                result, _ = self.evaluate(broker=broker, account=account)
                self.assertFalse(result["ok"], result)
                self.assertEqual(result["status"], "BLOCKED_MIN_LOT_EXCEEDS_RISK_OR_MARGIN")
                self.assertIsNone(result["candidateVolume"])

    def test_missing_or_stale_quote_never_suggests_volume(self):
        for kw in ({"quote_fresh": False}, {"quote_age_seconds": None},
                   {"quote_age_seconds": 61}, {"quote_age_seconds": float("inf")}):
            with self.subTest(kw=kw):
                result, _ = self.evaluate(**kw)
                self.assertFalse(result["ok"], result)
                self.assertEqual(result["status"], "BLOCKED_QUOTE_UNVERIFIED")

    def test_missing_exposure_cost_or_daily_evidence_is_blocked(self):
        for kw in ({"risk_inputs_verified": False}, {"costs_verified": False},
                   {"existing_sl_risk_usd": None}, {"pending_sl_risk_usd": None},
                   {"daily_remaining_risk_usd": None},
                   {"costs_usd_per_lot": None},
                   {"daily_remaining_risk_usd": -1}):
            with self.subTest(kw=kw):
                result, _ = self.evaluate(**kw)
                self.assertFalse(result["ok"], result)
                self.assertEqual(result["status"], "BLOCKED_RISK_EVIDENCE_UNVERIFIED")

    def test_budget_exhaustion_and_unapproved_risk_are_blocked(self):
        for risk in (1.01, 100, 0, -1, None):
            result, _ = self.evaluate(risk=risk)
            self.assertFalse(result["ok"], result)
            self.assertEqual(result["status"], "BLOCKED_RISK_POLICY")
        for kw in ({"existing_sl_risk_usd": 60.0},
                   {"pending_sl_risk_usd": 60.0},
                   {"daily_remaining_risk_usd": 0}):
            result, _ = self.evaluate(**kw)
            self.assertFalse(result["ok"], result)
            self.assertEqual(result["status"], "BLOCKED_RISK_BUDGET_EXHAUSTED")

    def test_invalid_broker_margin_and_loss_api_fail_closed(self):
        for failure in ("profit_error", "profit_nan", "profit_positive",
                        "margin_error", "margin_nan", "margin_none"):
            with self.subTest(failure=failure):
                broker = MockBroker()
                broker.broken = failure
                result, _ = self.evaluate(broker=broker)
                self.assertFalse(result["ok"], result)
                self.assertEqual(result["status"], "BLOCKED_BROKER_PRICING_UNVERIFIED")
                self.assertEqual(broker.sent, [])

        for api in ("order_calc_profit", "order_calc_margin"):
            broker = MockBroker()
            setattr(broker, api, None)
            result, _ = self.evaluate(broker=broker)
            self.assertEqual(result["status"], "BLOCKED_BROKER_PRICING_UNVERIFIED")

    def test_unverified_account_and_symbol_contract_are_blocked(self):
        result, _ = self.evaluate(account=self.account(margin_free=0))
        self.assertEqual(result["status"], "BLOCKED_ACCOUNT_UNVERIFIED")
        result, _ = self.evaluate(account=self.account(equity=float("nan")))
        self.assertEqual(result["status"], "BLOCKED_ACCOUNT_UNVERIFIED")
        for name, value in (("min_vol", None), ("step", 0), ("max_vol", float("nan"))):
            broker = MockBroker()
            setattr(broker, name, value)
            result, _ = self.evaluate(broker=broker)
            self.assertEqual(result["status"], "BLOCKED_SYMBOL_UNVERIFIED")

    def test_wrong_side_stop_or_missing_dca_policy_cannot_suggest_lot(self):
        broker = MockBroker()
        result = recommend_broker_auto_lot_shadow(
            broker, self.account(), "XAUUSD.G", "BUY", 4000.2, 4009.9, 0.8,
            **assumptions()[2],
        )
        self.assertEqual(result["status"], "BLOCKED_INVALID_STOP")
        result, _ = self.evaluate(dca_layer=True)
        self.assertEqual(result["status"], "BLOCKED_DCA_POLICY_UNVERIFIED")

    def test_no_orders_arm_mutation_or_runtime_config_side_effects(self):
        source = (Path(__file__).resolve().parents[1] / "scripts/v6_auto_lot_shadow.py").read_text()
        self.assertNotIn("order_send(", source)
        self.assertNotIn("arm_live", source)
        self.assertNotIn("MetaTrader5", source)
        self.assertNotIn("write_text(", source)
        live_gateway = (Path(__file__).resolve().parents[1] / "scripts/mt5-direct-probe.py").read_text()
        standalone = (Path(__file__).resolve().parents[1] / "scripts/xauusd-standalone-server.mjs").read_text()
        self.assertNotIn("v6_auto_lot_shadow", live_gateway)
        self.assertNotIn("v6_auto_lot_shadow", standalone)
        self.assertIn('orderSizingMode: "FIXED_LOT"', (Path(__file__).resolve().parents[1] / "scripts/v6-execution-sizing-disclosure.mjs").read_text())


if __name__ == "__main__":
    unittest.main()
