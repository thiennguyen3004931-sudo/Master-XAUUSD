"""Offline tests for G2 read-only, non-atomic broker snapshot adapter (#76)."""
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
    ORDER_TYPE_BUY_LIMIT = 2
    ORDER_TYPE_SELL_LIMIT = 3
    ORDER_TYPE_BUY_STOP = 4
    ORDER_TYPE_SELL_STOP = 5
    ORDER_TYPE_BUY_STOP_LIMIT = 6
    ORDER_TYPE_SELL_STOP_LIMIT = 7

    def __init__(self, now_utc=1700000100.0):
        self.now_utc = now_utc
        self._account = SimpleNamespace(login=123456, server="DBGMarkets-Live", equity=4000.0, margin_free=4000.0)
        self._ticks = {
            "XAUUSD.G": SimpleNamespace(bid=4000.00, ask=4000.25, time=now_utc - 2.0),
            "EURUSD": SimpleNamespace(bid=1.1020, ask=1.1022, time=now_utc - 3.0),
        }
        self._positions = []
        self._orders = []
        self._on_account_info = None
        self._on_positions_get = None
        self._on_orders_get = None
        self._on_calc_profit = None

    def account_info(self):
        if self._on_account_info:
            return self._on_account_info()
        return self._account

    def symbol_info(self, symbol):
        return SimpleNamespace(name=symbol, point=0.01, volume_min=0.01, volume_step=0.01, volume_max=50.0)

    def symbol_info_tick(self, symbol):
        return self._ticks.get(symbol)

    def positions_get(self):
        if self._on_positions_get:
            return self._on_positions_get()
        return self._positions

    def orders_get(self):
        if self._on_orders_get:
            return self._on_orders_get()
        return self._orders

    def order_calc_profit(self, order_type, symbol, lot, entry, stop):
        if self._on_calc_profit:
            self._on_calc_profit()
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
    def test_collects_multi_symbol_live_ticks_and_discloses_nonatomic_origin(self):
        broker = MockReadOnlyBroker()
        broker._positions = [
            SimpleNamespace(ticket=11, symbol="XAUUSD.G", type=0, volume=0.02, price_open=3980.0, sl=3990.0),
            SimpleNamespace(ticket=12, symbol="EURUSD", type=0, volume=0.03, price_open=1.1000, sl=1.0950),
        ]
        broker._orders = [
            SimpleNamespace(ticket=21, symbol="XAUUSD.G", type=2, volume_current=0.01, price_open=3995.0, sl=3988.0),
        ]
        res = base_call(broker)
        self.assertTrue(res["ok"], res)
        self.assertFalse(res["executionEnabled"])
        self.assertFalse(res["runtimePreSendAccepted"])
        self.assertEqual(res["snapshotOrigin"], SNAPSHOT_ORIGIN_NOTE)
        self.assertEqual(res["costProvenance"], COST_PROVENANCE_UNVERIFIED)
        self.assertEqual(res["observedTickSymbols"], ["eurusd", "xauusd.g"])
        self.assertLess(res["candidateVolume"], 0.04)

    def test_missing_zero_negative_bool_or_duplicate_tickets_fail_closed(self):
        for bad_ticket in (None, 0, -5, True, "bad"):
            broker = MockReadOnlyBroker()
            broker._positions = [
                SimpleNamespace(ticket=bad_ticket, symbol="XAUUSD.G", type=0, volume=0.02, price_open=3980.0, sl=3990.0)
            ]
            self.assertEqual(base_call(broker)["status"], "BLOCKED_OPEN_EXPOSURE_UNVERIFIED")

            broker_ord = MockReadOnlyBroker()
            broker_ord._orders = [
                SimpleNamespace(ticket=bad_ticket, symbol="XAUUSD.G", type=2, volume_current=0.01, price_open=3995.0, sl=3988.0)
            ]
            self.assertEqual(base_call(broker_ord)["status"], "BLOCKED_PENDING_EXPOSURE_UNVERIFIED")

        broker_dup = MockReadOnlyBroker()
        broker_dup._positions = [
            SimpleNamespace(ticket=11, symbol="XAUUSD.G", type=0, volume=0.02, price_open=3980.0, sl=3990.0),
            SimpleNamespace(ticket=11, symbol="XAUUSD.G", type=0, volume=0.02, price_open=3980.0, sl=3990.0),
        ]
        self.assertEqual(base_call(broker_dup)["status"], "BLOCKED_OPEN_EXPOSURE_UNVERIFIED")

    def test_post_pricing_account_or_inventory_drift_is_rejected(self):
        broker = MockReadOnlyBroker()

        def mutate_account_during_pricing():
            broker._account = SimpleNamespace(login=999999, server="DBGMarkets-Live", equity=4000.0, margin_free=4000.0)

        broker._on_calc_profit = mutate_account_during_pricing
        res = base_call(broker)
        self.assertEqual(res["decision"], "NO_TRADE")
        self.assertEqual(res["status"], "BLOCKED_ACCOUNT_SNAPSHOT_CHANGED")

        broker2 = MockReadOnlyBroker()

        def mutate_positions_during_pricing():
            broker2._positions = [
                SimpleNamespace(ticket=99, symbol="XAUUSD.G", type=0, volume=0.05, price_open=3990.0, sl=3980.0)
            ]

        broker2._on_calc_profit = mutate_positions_during_pricing
        res2 = base_call(broker2)
        self.assertEqual(res2["decision"], "NO_TRADE")
        self.assertEqual(res2["status"], "BLOCKED_INVENTORY_SNAPSHOT_DRIFT")

    def test_missing_pending_order_constants_fails_closed(self):
        broker = MockReadOnlyBroker()
        broker.ORDER_TYPE_BUY_LIMIT = None
        broker._orders = [
            SimpleNamespace(ticket=21, symbol="XAUUSD.G", type=2, volume_current=0.01, price_open=3995.0, sl=3988.0)
        ]
        res = base_call(broker)
        self.assertEqual(res["decision"], "NO_TRADE")
        self.assertEqual(res["status"], "BLOCKED_PENDING_EXPOSURE_UNVERIFIED")

    def test_exceptions_and_pre_pricing_drift_return_no_trade(self):
        broker = MockReadOnlyBroker()

        def boom():
            raise RuntimeError("MT5 IPC disconnected")

        broker._on_positions_get = boom
        self.assertEqual(base_call(broker)["status"], "BLOCKED_OPEN_EXPOSURE_UNVERIFIED")

        broker2 = MockReadOnlyBroker()
        pos_calls = {"n": 0}

        def drifting_positions():
            pos_calls["n"] += 1
            sl = 3990.0 if pos_calls["n"] == 1 else 3985.0
            return [SimpleNamespace(ticket=11, symbol="XAUUSD.G", type=0, volume=0.02, price_open=3980.0, sl=sl)]

        broker2._on_positions_get = drifting_positions
        self.assertEqual(base_call(broker2)["status"], "BLOCKED_INVENTORY_SNAPSHOT_DRIFT")


if __name__ == "__main__":
    unittest.main()
