from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .broker_time import denormalize_timestamp_ms
from .errors import BridgeError
from .mt5_gateway import Mt5Gateway


def _row_value(row: Any, key: str, default: Any = None) -> Any:
    try:
        return row[key]
    except Exception:
        return getattr(row, key, default)


def historical_ticks(
    gateway: Mt5Gateway,
    canonical_symbol: str,
    from_ms: int,
    to_ms: int,
    max_ticks: int = 1_000_000,
) -> list[dict[str, Any]]:
    """Return broker-native ticks for an explicit UTC range.

    This helper is strictly read-only. The request range is converted from real
    UTC to the broker pseudo-UTC clock before calling MetaTrader. Returned tick
    timestamps stay on the broker clock here and are normalized exactly once by
    the bridge response layer.
    """
    try:
        start_ms = int(from_ms)
        end_ms = int(to_ms)
    except (TypeError, ValueError):
        raise BridgeError("Invalid tick history range", 400, "TICK_RANGE_INVALID")

    if start_ms < 0 or end_ms <= start_ms:
        raise BridgeError("Invalid tick history range", 400, "TICK_RANGE_INVALID")

    max_range_ms = 7 * 24 * 60 * 60 * 1000
    if end_ms - start_ms > max_range_ms:
        raise BridgeError(
            "Tick history range exceeds 7 days",
            400,
            "TICK_RANGE_TOO_LARGE",
        )

    tick_limit = min(max(1, int(max_ticks)), 1_000_000)
    broker_symbol = gateway._ensure_symbol(canonical_symbol)
    broker_start_ms = denormalize_timestamp_ms(start_ms)
    broker_end_ms = denormalize_timestamp_ms(end_ms)
    start = datetime.fromtimestamp(broker_start_ms / 1000.0, tz=timezone.utc)
    end = datetime.fromtimestamp(broker_end_ms / 1000.0, tz=timezone.utc)

    with gateway._lock:
        info = gateway._read_with_reconnect_locked("symbol_info", broker_symbol)
        rows = gateway._read_with_reconnect_locked(
            "copy_ticks_range",
            broker_symbol,
            start,
            end,
            gateway.mt5.COPY_TICKS_ALL,
        )

    if info is None:
        raise BridgeError(
            f"No symbol specification for {broker_symbol}",
            404,
            "SYMBOL_NOT_FOUND",
        )
    if rows is None:
        raise BridgeError(
            f"copy_ticks_range failed: {gateway.mt5.last_error()}",
            503,
            "TICKS_UNAVAILABLE",
        )
    if len(rows) > tick_limit:
        raise BridgeError(
            f"Tick history contains {len(rows)} ticks; limit is {tick_limit}",
            400,
            "TICK_RANGE_TICK_LIMIT",
        )

    output: list[dict[str, Any]] = []
    for sequence, row in enumerate(rows):
        time_msc = _row_value(row, "time_msc")
        if time_msc is None:
            time_seconds = _row_value(row, "time")
            if time_seconds is None:
                raise BridgeError("Historical tick is missing timestamp", 503, "TICK_ROW_INVALID")
            time_msc = int(time_seconds) * 1000

        output.append(
            {
                "symbol": canonical_symbol,
                "brokerSymbol": broker_symbol,
                "timestamp": int(time_msc),
                "sequence": sequence,
                "bid": float(_row_value(row, "bid", 0.0) or 0.0),
                "ask": float(_row_value(row, "ask", 0.0) or 0.0),
                "last": float(_row_value(row, "last", 0.0) or 0.0),
                "volume": float(_row_value(row, "volume", 0.0) or 0.0),
            }
        )

    return output
