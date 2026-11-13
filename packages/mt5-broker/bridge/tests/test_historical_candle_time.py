from __future__ import annotations

import os
import sys
import threading
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
if str(BRIDGE_ROOT) not in sys.path:
    sys.path.insert(0, str(BRIDGE_ROOT))

# historical_candles imports Mt5Gateway only for type annotations. Stub that
# dependency so this focused regression remains stdlib-only in Linux CI.
_previous_gateway = sys.modules.get("mt5_bridge.mt5_gateway")
_gateway_module = types.ModuleType("mt5_bridge.mt5_gateway")
_gateway_module.Mt5Gateway = type("Mt5Gateway", (), {})
sys.modules["mt5_bridge.mt5_gateway"] = _gateway_module

try:
    from mt5_bridge.historical_candles import historical_candles
finally:
    if _previous_gateway is None:
        sys.modules.pop("mt5_bridge.mt5_gateway", None)
    else:
        sys.modules["mt5_bridge.mt5_gateway"] = _previous_gateway


class _Mt5:
    TIMEFRAME_M5 = 5

    @staticmethod
    def last_error() -> tuple[int, str]:
        return (0, "ok")


class _Gateway:
    def __init__(self, rows: list[dict[str, object]] | None = None) -> None:
        self.mt5 = _Mt5()
        self._lock = threading.RLock()
        self.captured: dict[str, object] = {}
        self.rows = [] if rows is None else rows

    def _ensure_symbol(self, canonical: str) -> str:
        return canonical

    def _read_with_reconnect_locked(self, method_name: str, *args: object):
        if method_name == "symbol_info":
            return SimpleNamespace(point=0.01)

        if method_name == "copy_rates_range":
            self.captured["method_name"] = method_name
            self.captured["args"] = args
            return self.rows

        raise AssertionError(f"Unexpected MT5 read: {method_name}")


class HistoricalCandleBrokerTimeRangeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.original_offset = os.environ.get("MT5_BROKER_TIME_OFFSET_SECONDS")

    def tearDown(self) -> None:
        if self.original_offset is None:
            os.environ.pop("MT5_BROKER_TIME_OFFSET_SECONDS", None)
        else:
            os.environ["MT5_BROKER_TIME_OFFSET_SECONDS"] = self.original_offset

    def test_utc_range_is_denormalized_to_broker_clock_before_copy_rates_range(self) -> None:
        os.environ["MT5_BROKER_TIME_OFFSET_SECONDS"] = "10800"
        gateway = _Gateway()

        from_ms = int(
            datetime(2026, 9, 11, 6, 5, tzinfo=timezone.utc).timestamp() * 1000
        )
        to_ms = int(
            datetime(2026, 9, 11, 6, 35, tzinfo=timezone.utc).timestamp() * 1000
        )

        self.assertEqual(
            historical_candles(gateway, "XAUUSD", "M5", from_ms, to_ms),
            [],
        )
        self.assertEqual(gateway.captured["method_name"], "copy_rates_range")

        broker_symbol, timeframe, start, end = gateway.captured["args"]  # type: ignore[misc]
        self.assertEqual(broker_symbol, "XAUUSD")
        self.assertEqual(timeframe, _Mt5.TIMEFRAME_M5)
        self.assertEqual(
            start,
            datetime(2026, 9, 11, 9, 5, tzinfo=timezone.utc),
            "UTC fromMs must be shifted to broker pseudo-UTC before copy_rates_range",
        )
        self.assertEqual(
            end,
            datetime(2026, 9, 11, 9, 35, tzinfo=timezone.utc),
            "UTC toMs must be shifted to broker pseudo-UTC before copy_rates_range",
        )

    def test_closed_broker_time_candle_is_not_rejected_as_future(self) -> None:
        os.environ["MT5_BROKER_TIME_OFFSET_SECONDS"] = "10800"
        real_now = datetime.now(tz=timezone.utc).replace(second=0, microsecond=0)
        real_open = real_now - timedelta(minutes=10)
        broker_open = real_open + timedelta(hours=3)
        gateway = _Gateway(
            rows=[
                {
                    "time": int(broker_open.timestamp()),
                    "spread": 20,
                    "open": 4400.0,
                    "high": 4401.0,
                    "low": 4399.0,
                    "close": 4400.5,
                    "tick_volume": 100,
                }
            ]
        )

        candles = historical_candles(
            gateway,
            "XAUUSD",
            "M5",
            int((real_now - timedelta(minutes=15)).timestamp() * 1000),
            int(real_now.timestamp() * 1000),
        )

        self.assertEqual(
            len(candles),
            1,
            "A candle closed in real UTC must remain closed when MT5 returns broker pseudo-UTC time",
        )
        self.assertEqual(candles[0]["openTime"], int(broker_open.timestamp() * 1000))


if __name__ == "__main__":
    unittest.main()
