from __future__ import annotations

from typing import Any

from .errors import BridgeError


_TIMEFRAME_DURATION_MS = {
    "M1": 60_000,
    "M5": 5 * 60_000,
    "M15": 15 * 60_000,
    "M30": 30 * 60_000,
    "H1": 60 * 60_000,
    "H4": 4 * 60 * 60_000,
    "D1": 24 * 60 * 60_000,
}


def candles_with_forming(
    gateway: Any,
    canonical_symbol: str,
    timeframe: str = "M15",
    count: int = 320,
) -> list[dict[str, Any]]:
    """Return historical closed bars plus the currently forming bar.

    This helper is intentionally separate from Mt5Gateway.candles(), whose
    contract remains closed-bars-only. Phase 7B uses this endpoint only during
    the configured 5-10 second pre-close window.
    """

    timeframe_key = str(timeframe).strip().upper()
    duration_ms = _TIMEFRAME_DURATION_MS.get(timeframe_key)
    if duration_ms is None:
        raise BridgeError(
            f"Unsupported timeframe {timeframe}",
            400,
            "TIMEFRAME_UNSUPPORTED",
        )

    try:
        safe_count = int(count)
    except (TypeError, ValueError):
        raise BridgeError("Invalid candle count", 400, "CANDLE_COUNT_INVALID")

    if safe_count < 3 or safe_count > 5000:
        raise BridgeError(
            "Candle count with forming bar must be between 3 and 5000",
            400,
            "CANDLE_COUNT_INVALID",
        )

    # Keep the existing closed-candle implementation as the source of truth
    # for all historical rows, then append exactly one current bar from MT5
    # position zero. MT5 documents start_pos=0 as the current bar.
    closed = gateway.candles(canonical_symbol, timeframe_key, safe_count - 1)
    broker_symbol = gateway._ensure_symbol(canonical_symbol)
    mt5_timeframe = getattr(gateway.mt5, f"TIMEFRAME_{timeframe_key}", None)
    if mt5_timeframe is None:
        raise BridgeError(
            f"Unsupported timeframe {timeframe}",
            400,
            "TIMEFRAME_UNSUPPORTED",
        )

    with gateway._lock:
        info = gateway._read_with_reconnect_locked("symbol_info", broker_symbol)
        if info is None:
            raise BridgeError(
                f"No symbol specification for {broker_symbol}",
                404,
                "SYMBOL_NOT_FOUND",
            )
        rows = gateway._read_with_reconnect_locked(
            "copy_rates_from_pos",
            broker_symbol,
            mt5_timeframe,
            0,
            1,
        )

    if rows is None or len(rows) < 1:
        raise BridgeError(
            f"Current candle unavailable: {gateway.mt5.last_error()}",
            503,
            "FORMING_CANDLE_UNAVAILABLE",
        )

    row = rows[-1]
    point = float(getattr(info, "point", 0.0) or 0.0)
    try:
        spread_points = float(row["spread"])
    except Exception:
        spread_points = 0.0

    open_time = int(row["time"]) * 1000
    forming = {
        "symbol": canonical_symbol,
        "brokerSymbol": broker_symbol,
        "timeframe": timeframe_key,
        "openTime": open_time,
        "closeTime": open_time + duration_ms,
        "open": float(row["open"]),
        "high": float(row["high"]),
        "low": float(row["low"]),
        "close": float(row["close"]),
        "volume": float(row["tick_volume"]),
        "spread": max(0.0, spread_points * point),
        "forming": True,
    }

    # Defensive ordering check. If MT5 momentarily returns a bar that is not
    # newer than the latest closed row, do not duplicate it.
    if closed and int(closed[-1].get("openTime", 0)) >= open_time:
        return closed

    return [*closed, forming]
