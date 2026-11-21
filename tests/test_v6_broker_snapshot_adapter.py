"""Offline tests for G2 read-only broker snapshot adapter (#76)."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.v6_broker_snapshot_adapter import (
    COST_PROVENANCE_UNVERIFIED,
    SNAPSHOT_ORIGIN_NOTE,
    evaluate_auto_lot_from_broker_session,
)


class MockReadOnlyBroker:
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    POSITION_TYPE_BUY = 0
    POSITION_TYPE_SELL = 1

    def __init__(self, now_utc=1700000100.0):
        self.now_utc = now_utc
        self._account = SimpleNamespace(login=123456, server="DBGMarkets-Live", equity=4000.0, margin_free=4000.0)
        self._ticks = {
            "XAUUSD.G": SimpleNamespace(bid=4000.00, ask=4000.25, time=now_utc - 2.0),
            "EURUSD": SimpleNamespace(bid=1.1020, ask=1.1022, time=now_utc - 3.0),
        }
        self._positions = []
        self._orders = []

    def account_info(self):
        return self._account

    def symbol_info(self, symbol):
        return SimpleNamespace(name=symbol, point=0.01, volume_min=0.01, volume_step=0.01, volume_max=50.0)

    def symbol_info_tick(self, symbol):
        return self._ticks.get(symbol)

    def positions_get(self):
        return self._positions

    def orders_get(self):
        return self._orders

    def order_calc_profit(self, order_type, symbol, lot, entry, stop):
        mult = 100000.0 if symbol == "EURUSD" else 100.0
        pnl = (stop - entry) if order_type == self.ORDER_TYPE_BUY else (entry - stop)
        return pnl * lot * mult

    def order_calc_margin(self, order_type, symbol, lot, entry):
        return lot * entry

    def order_send(self, *args, **kwargs):
        raise AssertionError("Read-only broker adapter must never call order_send")


def base_call(broker, **overrides):
    kw = dict(
        broker=broker,
        expected_account_login=123456,
        expected_server="DBGMarkets-Live",
        symbol="XAUUSD.G",
        side="BUY",
        now_utc=1700000100.0,
        stop_loss_price=3993.25,
        risk_percent=0.8,
        daily_remaining_risk_usd=100.0,
        commission_usd_per_lot=7.0,
        slippage_usd_per_lot=3.0,
    )
    kw.update(overrides)
    return evaluate_auto_lot_from_broker_session(**kw)


class BrokerSnapshotAdapterTests(unittest.TestCase):
    def test_collects_multi_symbol_live_ticks_and_prices_trailing_sl_drawdown(self):
        broker = MockReadOnlyBroker()
        broker._positions = [
            SimpleNamespace(symbol="XAUUSD.G", type=0, volume=0.02, price_open=3980.0, sl=3990.0),
            SimpleNamespace(symbol="EURUSD", type=0, volume=0.03, price_open=1.1000, sl=1.0950),
        ]
        broker._orders = [
            SimpleNamespace(symbol="XAUUSD.G", type=2, volume_current=0.01, price_open=3995.0, sl=3988.0),
        ]
        res = base_call(broker)
        self.assertTrue(res["ok"], res)
        self.assertFalse(res["executionEnabled"])
        self.assertFalse(res["runtimePreSendAccepted"])
        self.assertEqual(res["snapshotOrigin"], SNAPSHOT_ORIGIN_NOTE)
        self.assertEqual(res["costProvenance"], COST_PROVENANCE_UNVERIFIED)
        self.assertEqual(res["observedTickSymbols"], ["eurusd", "xauusd.g"])
        self.assertGreater(res["openMarkToStopEquityDrawdownUsd"], 40.0)
        self.assertGreater(res["pendingRiskUsd"], 7.0)
        self.assertLess(res["candidateVolume"], 0.04)

    def test_stale_or_missing_foreign_symbol_tick_fails_closed(self):
        broker = MockReadOnlyBroker()
        broker._positions = [
            SimpleNamespace(symbol="EURUSD", type=0, volume=0.02, price_open=1.1000, sl=1.0950),
        ]
        broker._ticks["EURUSD"] = SimpleNamespace(bid=1.1020, ask=1.1022, time=1700000000.0)
        res = base_call(broker)
        self.assertEqual(res["decision"], "NO_TRADE")
        self.assertEqual(res["status"], "BLOCKED_OPEN_POSITION_MARK_UNVERIFIED")

        del broker._ticks["EURUSD"]
        res_missing = base_call(broker)
        self.assertEqual(res_missing["decision"], "NO_TRADE")
        self.assertEqual(res_missing["status"], "BLOCKED_OPEN_POSITION_MARK_UNVERIFIED")

    def test_unavailable_positions_or_orders_inventory_fails_closed(self):
        broker = MockReadOnlyBroker()
        broker._positions = None
        self.assertEqual(base_call(broker)["status"], "BLOCKED_OPEN_EXPOSURE_UNVERIFIED")

        broker = MockReadOnlyBroker()
        broker._orders = None
        self.assertEqual(base_call(broker)["status"], "BLOCKED_PENDING_EXPOSURE_UNVERIFIED")

        broker._orders = [SimpleNamespace(symbol="XAUUSD.G", type=99, volume_current=0.01, price_open=3995.0, sl=3988.0)]
        self.assertEqual(base_call(broker)["status"], "BLOCKED_PENDING_EXPOSURE_UNVERIFIED")

    def test_sell_position_uses_ask_as_closing_mark_and_never_calls_order_send(self):
        broker = MockReadOnlyBroker()
        broker._positions = [
            SimpleNamespace(symbol="XAUUSD.G", type=1, volume=0.02, price_open=4020.0, sl=4010.0),
        ]
        res = base_call(broker, side="SELL", stop_loss_price=4007.0)
        self.assertTrue(res["ok"], res)
        self.assertAlmostEqual(res["openMarkToStopEquityDrawdownUsd"], 20.475, places=4)
        self.assertFalse(res["executionEnabled"])

    def test_account_mismatch_or_missing_account_fails_closed(self):
        broker = MockReadOnlyBroker()
        broker._account = None
        self.assertEqual(base_call(broker)["status"], "BLOCKED_ACCOUNT_UNVERIFIED")

        broker._account = SimpleNamespace(login=999999, server="DBGMarkets-Live", equity=4000.0, margin_free=4000.0)
        self.assertEqual(base_call(broker)["status"], "BLOCKED_ACCOUNT_SERVER_MISMATCH")


if __name__ == "__main__":
    unittest.main()
