"""Mock-broker tests: these never connect to or place an actual MT5 order."""
import importlib.util
import sys
import time
import unittest
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
        return self.positions

    def order_send(self, request):
        self.sent.append(request)
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

    def test_unprotected_existing_position_blocks_new_risk(self):
        mt5 = MockBroker()
        mt5.positions = [SimpleNamespace(sl=0, type=0, symbol="XAUUSD.G", volume=0.01, price_open=4000)]
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16
        })
        self.assertFalse(result["ok"])
        self.assertEqual(len(mt5.sent), 0)

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
