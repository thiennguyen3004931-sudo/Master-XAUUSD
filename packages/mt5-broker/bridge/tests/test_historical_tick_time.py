from __future__ import annotations

import os
import sys
import threading
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
if str(BRIDGE_ROOT) not in sys.path:
    sys.path.insert(0, str(BRIDGE_ROOT))

_previous_gateway = sys.modules.get("mt5_bridge.mt5_gateway")
_gateway_module = types.ModuleType("mt5_bridge.mt5_gateway")
_gateway_module.Mt5Gateway = type("Mt5Gateway", (), {})
sys.modules["mt5_bridge.mt5_gateway"] = _gateway_module
try:
    from mt5_bridge.historical_ticks import historical_ticks
finally:
    if _previous_gateway is None:
        sys.modules.pop("mt5_bridge.mt5_gateway", None)
    else:
        sys.modules["mt5_bridge.mt5_gateway"] = _previous_gateway


class _Mt5:
    COPY_TICKS_ALL = 7

    @staticmethod
    def last_error() -> tuple[int, str]:
        return (0, "ok")


class _Gateway:
    def __init__(self, rows=None) -> None:
        self.mt5 = _Mt5()
        self._lock = threading.RLock()
        self.rows = [] if rows is None else rows
        self.captured = {}

    def _ensure_symbol(self, canonical: str) -> str:
        return canonical

    def _read_with_reconnect_locked(self, method_name: str, *args):
        if method_name == "symbol_info":
            return SimpleNamespace(point=0.01)
        if method_name == "copy_ticks_range":
            self.captured["method_name"] = method_name
            self.captured["args"] = args
            return self.rows
        raise AssertionError(f"Unexpected MT5 read: {method_name}")


class HistoricalTickBrokerTimeRangeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.original_offset = os.environ.get("MT5_BROKER_TIME_OFFSET_SECONDS")

    def tearDown(self) -> None:
        if self.original_offset is None:
            os.environ.pop("MT5_BROKER_TIME_OFFSET_SECONDS", None)
        else:
            os.environ["MT5_BROKER_TIME_OFFSET_SECONDS"] = self.original_offset

    def test_utc_range_is_denormalized_before_copy_ticks_range(self) -> None:
        os.environ["MT5_BROKER_TIME_OFFSET_SECONDS"] = "10800"
        gateway = _Gateway()
        from_ms = int(datetime(2026, 9, 11, 6, 5, tzinfo=timezone.utc).timestamp() * 1000)
        to_ms = int(datetime(2026, 9, 11, 6, 6, tzinfo=timezone.utc).timestamp() * 1000)

        self.assertEqual(historical_ticks(gateway, "XAUUSD", from_ms, to_ms), [])
        self.assertEqual(gateway.captured["method_name"], "copy_ticks_range")
        broker_symbol, start, end, flags = gateway.captured["args"]
        self.assertEqual(broker_symbol, "XAUUSD")
        self.assertEqual(flags, _Mt5.COPY_TICKS_ALL)
        self.assertEqual(start, datetime(2026, 9, 11, 9, 5, tzinfo=timezone.utc))
        self.assertEqual(end, datetime(2026, 9, 11, 9, 6, tzinfo=timezone.utc))

    def test_ticks_preserve_broker_order_with_sequence(self) -> None:
        gateway = _Gateway(rows=[
            {"time_msc": 1000, "bid": 100.0, "ask": 100.2, "last": 100.1, "volume": 1},
            {"time_msc": 1000, "bid": 100.1, "ask": 100.3, "last": 100.2, "volume": 2},
            {"time_msc": 1001, "bid": 100.2, "ask": 100.4, "last": 100.3, "volume": 3},
        ])
        rows = historical_ticks(gateway, "XAUUSD", 1, 2_000)
        self.assertEqual([row["sequence"] for row in rows], [0, 1, 2])
        self.assertEqual([row["timestamp"] for row in rows], [1000, 1000, 1001])
        self.assertEqual(rows[1]["bid"], 100.1)
        self.assertEqual(rows[1]["ask"], 100.3)

    def test_invalid_or_excessive_range_fails_closed(self) -> None:
        gateway = _Gateway()
        with self.assertRaises(Exception):
            historical_ticks(gateway, "XAUUSD", 10_000, 10_000)
        with self.assertRaises(Exception):
            historical_ticks(gateway, "XAUUSD", 0, 8 * 24 * 60 * 60 * 1000)


if __name__ == "__main__":
    unittest.main()
