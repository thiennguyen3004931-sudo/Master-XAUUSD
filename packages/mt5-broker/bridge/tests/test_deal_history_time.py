from __future__ import annotations

import os
import sys
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path


BRIDGE_ROOT = Path(__file__).resolve().parents[1]
if str(BRIDGE_ROOT) not in sys.path:
    sys.path.insert(0, str(BRIDGE_ROOT))

# mt5_gateway only needs the request classes for type annotations in this
# read-only regression. Stub that module so the dedicated stdlib-only Linux CI
# never needs the Windows-only MetaTrader5 dependency. Restore sys.modules
# immediately after importing Mt5Gateway so broader unittest discovery can
# import the real request models without cross-test contamination.
_previous_models = sys.modules.get("mt5_bridge.models")
models = types.ModuleType("mt5_bridge.models")
for model_name in ("CloseRequest", "ModifyRequest", "OrderRequest"):
    setattr(models, model_name, type(model_name, (), {}))
sys.modules["mt5_bridge.models"] = models

try:
    from mt5_bridge.mt5_gateway import Mt5Gateway
finally:
    if _previous_models is None:
        sys.modules.pop("mt5_bridge.models", None)
    else:
        sys.modules["mt5_bridge.models"] = _previous_models


class _Settings:
    def broker_symbol(self, canonical: str) -> str:
        return canonical

    def canonical_symbol(self, broker_symbol: str) -> str:
        return broker_symbol


class _Mt5:
    DEAL_TYPE_BUY = 0
    DEAL_TYPE_SELL = 1
    DEAL_ENTRY_IN = 0
    DEAL_ENTRY_OUT = 1
    DEAL_ENTRY_INOUT = 2
    DEAL_ENTRY_OUT_BY = 3


class DealHistoryBrokerTimeTest(unittest.TestCase):
    def test_utc_range_is_denormalized_to_broker_clock_before_history_query(self) -> None:
        previous_offset = os.environ.get("MT5_BROKER_TIME_OFFSET_SECONDS")
        os.environ["MT5_BROKER_TIME_OFFSET_SECONDS"] = "10800"

        try:
            gateway = Mt5Gateway(_Settings(), object(), _Mt5())
            captured: dict[str, object] = {}

            def record_read(method_name: str, *args: object, **kwargs: object) -> list[object]:
                captured["method_name"] = method_name
                captured["args"] = args
                captured["kwargs"] = kwargs
                return []

            gateway._read_with_reconnect_locked = record_read  # type: ignore[method-assign]

            from_ms = int(
                datetime(2026, 8, 31, 0, 0, tzinfo=timezone.utc).timestamp() * 1000
            )
            to_ms = int(
                datetime(2026, 8, 31, 1, 0, tzinfo=timezone.utc).timestamp() * 1000
            )

            self.assertEqual(gateway.deals(from_ms, to_ms, "XAUUSD"), [])
            self.assertEqual(captured["method_name"], "history_deals_get")

            start, end = captured["args"]  # type: ignore[misc]
            self.assertEqual(
                start,
                datetime(2026, 8, 31, 3, 0, tzinfo=timezone.utc),
                "UTC fromMs must be shifted to broker pseudo-UTC before history_deals_get",
            )
            self.assertEqual(
                end,
                datetime(2026, 8, 31, 4, 0, tzinfo=timezone.utc),
                "UTC toMs must be shifted to broker pseudo-UTC before history_deals_get",
            )
        finally:
            if previous_offset is None:
                os.environ.pop("MT5_BROKER_TIME_OFFSET_SECONDS", None)
            else:
                os.environ["MT5_BROKER_TIME_OFFSET_SECONDS"] = previous_offset


if __name__ == "__main__":
    unittest.main()
