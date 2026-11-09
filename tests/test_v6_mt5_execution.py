"""Mock-broker tests: these never connect to or place an actual MT5 order."""
import importlib.util
import sys
import time
import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("xauusd_mt5_direct_probe", SCRIPTS / "mt5-direct-probe.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class MockBroker:
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    ORDER_FILLING_FOK = 0
    ORDER_TIME_GTC = 0
    TRADE_ACTION_DEAL = 1
    TRADE_ACTION_SLTP = 6
    TRADE_RETCODE_DONE = 10009

    def __init__(self):
        self.positions = []
        self.asks = 4000.20
        self.bids = 4000.00
        self.sent = []

    def symbol_info(self, symbol):
        return SimpleNamespace(
            visible=True, volume_min=0.01, volume_step=0.01,
            volume_max=100.0, digits=2, point=0.01, filling_mode=1,
            trade_stops_level=20
        )

    def symbol_info_tick(self, symbol):
        return SimpleNamespace(ask=self.asks, bid=self.bids, time=int(time.time()))

    def account_info(self):
        return SimpleNamespace(equity=4000.0)

    def order_calc_profit(self, kind, symbol, lot, entry, stop):
        if kind == 0:
            return (stop - entry) * lot * 100.0
        return (entry - stop) * lot * 100.0

    def positions_get(self, *args, **kwargs):
        ticket = kwargs.get("ticket")
        if ticket is not None:
            return [p for p in self.positions if int(getattr(p, "ticket", 0)) == int(ticket)]
        symbol = kwargs.get("symbol")
        if symbol is not None:
            return [p for p in self.positions if str(p.symbol) == str(symbol)]
        return self.positions

    def order_send(self, request):
        self.sent.append(request)
        if request["action"] == self.TRADE_ACTION_SLTP:
            for p in self.positions:
                if p.ticket == request["position"]:
                    p.sl = request["sl"]
                    p.tp = request["tp"]
            return SimpleNamespace(retcode=10009, order=123)
        return SimpleNamespace(retcode=10009, order=123, price=request["price"])


class ExecutionRiskTest(unittest.TestCase):
    def test_above_risk_budget_is_rejected_before_send(self):
        mt5 = MockBroker()
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.05, "slDistance": 6.8, "tpDistance": 16,
            "maxRiskPercent": 0.5
        })
        self.assertFalse(result["ok"])
        self.assertEqual(mt5.sent, [])

    def test_within_risk_budget_sends_protected_order(self):
        mt5 = MockBroker()
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16,
            "maxRiskPercent": 0.5
        })
        self.assertTrue(result["ok"])
        self.assertEqual(len(mt5.sent), 1)
        self.assertGreater(mt5.sent[0]["tp"], mt5.sent[0]["price"])
        self.assertLess(mt5.sent[0]["sl"], mt5.sent[0]["price"])

    def test_high_spread_is_rejected(self):
        mt5 = MockBroker()
        mt5.asks = 4002.0
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16
        })
        self.assertFalse(result["ok"])
        self.assertEqual(len(mt5.sent), 0)

    def test_lot_not_rounded_up_to_broker_step(self):
        mt5 = MockBroker()
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.025, "slDistance": 6.8, "tpDistance": 16
        })
        self.assertFalse(result["ok"])
        self.assertEqual(mt5.sent, [])

    def test_unfavorable_reward_risk_rejected_at_actual_quote(self):
        mt5 = MockBroker()
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.01, "slDistance": 6.8, "tpDistance": 5,
            "minRewardRisk": 1.6
        })
        self.assertFalse(result["ok"])
        self.assertEqual(mt5.sent, [])

    def test_broker_pending_order_not_claimed_as_fill(self):
        class PendingBroker(MockBroker):
            def order_send(self, request):
                self.sent.append(request)
                return SimpleNamespace(retcode=10008)
        mt5 = PendingBroker()
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.01, "slDistance": 6.8, "tpDistance": 16
        })
        self.assertFalse(result["ok"])
        self.assertTrue(result.get("pending"))

    def test_unprotected_existing_position_blocks_new_risk(self):
        mt5 = MockBroker()
        mt5.positions = [SimpleNamespace(sl=0, type=0, symbol="XAUUSD.G", volume=0.01, price_open=4000)]
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16
        })
        self.assertFalse(result["ok"])
        self.assertEqual(len(mt5.sent), 0)

    def test_sl_modification_broker_readback_and_monotonic(self):
        mt5 = MockBroker()
        position = SimpleNamespace(
            symbol="XAUUSD.G", ticket=202, type=0, price_open=3990,
            price_current=3997, sl=3983.0, tp=4020.0, magic=270715
        )
        mt5.positions = [position]
        update = engine.modify_position_sl_tp(mt5, position, 3990.25, 4020.0, "BE")
        self.assertTrue(update["ok"], update)
        self.assertGreaterEqual(position.sl, 3990.25)
        previous_sent = len(mt5.sent)
        denied = engine.modify_position_sl_tp(mt5, position, 3988, 4020.0, "Invalid widen")
        self.assertFalse(denied["ok"])
        self.assertEqual(len(mt5.sent), previous_sent)
        self.assertAlmostEqual(position.sl, 3990.25)

    def test_sl_broker_ack_without_readback_must_not_claim_success(self):
        class AckWithoutReadback(MockBroker):
            def order_send(self, req):
                self.sent.append(req)
                return SimpleNamespace(retcode=10009)
        mt5 = AckWithoutReadback()
        p = SimpleNamespace(symbol="XAUUSD.G", ticket=303, type=0, price_open=3990,
                            price_current=3997, sl=3983, tp=4020, magic=270715)
        mt5.positions = [p]
        result = engine.modify_position_sl_tp(mt5, p, 3990.25, 4020, "Unconfirmed BE")
        self.assertFalse(result["ok"])
        self.assertFalse(result["changed"])

    def test_operator_be_never_loosens_profitable_sl(self):
        mt5 = MockBroker()
        p = SimpleNamespace(symbol="XAUUSD.G", ticket=304, type=0, price_open=3990,
                            price_current=3997, sl=3995, tp=4020, magic=270715)
        mt5.positions = [p]
        result = engine.move_sl_to_breakeven(mt5, 304)
        self.assertTrue(result["ok"])
        self.assertAlmostEqual(p.sl, 3995)
        self.assertEqual(mt5.sent, [])

    def test_auto_sideway_blocks_pyramiding(self):
        signal = {"allowed": True, "side": "BUY", "confidence": 88,
                  "strategyMode": "BOT_2_SIDEWAY", "requestedMode": "AUTO_REGIME"}
        ok, why = engine.check_bot_signal_for_mode(signal, "AUTO_REGIME", "BUY", 85)
        self.assertFalse(ok)
        self.assertIn("sideway", why.lower())

    def test_sideway_dca_prohibited(self):
        signal = {
            "allowed": True, "side": "BUY", "confidence": 88,
            "requestedMode": "BOT_2_SIDEWAY", "patternName": "Range"
        }
        ok, reason = engine.check_bot_signal_for_mode(signal, "BOT_2_SIDEWAY", "BUY", 85)
        self.assertFalse(ok)
        self.assertIn("sideway", reason.lower())

    def test_dca_read_only_preview_does_not_send(self):
        mt5 = MockBroker()
        mt5.positions = [SimpleNamespace(
            type=0, profit=10, symbol="XAUUSD.G", ticket=101, time=1000,
            price_open=4000, price_current=4010, sl=4000.25, volume=0.02, tp=4020
        )]
        signal = {
            "allowed": True, "side": "BUY", "confidence": 88,
            "requestedMode": "BOT_1_TREND", "patternName": "Trend",
            "closedM15Time": 3000000, "sl": 4001, "tp": 4030
        }
        result = engine.evaluate_and_execute_positive_dca(
            mt5, "XAUUSD.G", mt5.positions, signal,
            {"enabled": True, "strategyMode": "BOT_1_TREND", "minConfidence": 85, "stepDistance": 4.5},
            execute=False
        )
        self.assertTrue(result["eligible"])
        self.assertFalse(result["executed"])
        self.assertEqual(len(mt5.sent), 0)


if __name__ == "__main__":
    unittest.main()
