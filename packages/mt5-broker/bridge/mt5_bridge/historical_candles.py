from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .broker_time import denormalize_timestamp_ms
from .errors import BridgeError
from .mt5_gateway import Mt5Gateway


def historical_candles(
    gateway: Mt5Gateway,
    canonical_symbol: str,
    timeframe: str,
    from_ms: int,
    to_ms: int,
    max_bars: int = 250_000,
) -> list[dict[str, Any]]:
    """Return closed broker-native candles for an explicit UTC range.

    This helper is strictly read-only. It exists for Phase 7C research/backtest
    and does not change trading permissions or terminal state.
    """
    try:
        start_ms = int(from_ms)
        end_ms = int(to_ms)
    except (TypeError, ValueError):
        raise BridgeError("Invalid candle history range", 400, "CANDLE_RANGE_INVALID")

    if start_ms < 0 or end_ms <= start_ms:
        raise BridgeError("Invalid candle history range", 400, "CANDLE_RANGE_INVALID")

    max_range_ms = 3 * 365 * 24 * 60 * 60 * 1000
    if end_ms - start_ms > max_range_ms:
        raise BridgeError(
            "Candle history range exceeds 3 years",
            400,
            "CANDLE_RANGE_TOO_LARGE",
        )

    timeframe_key = str(timeframe).strip().upper()
    timeframe_map = {
        "M1": getattr(gateway.mt5, "TIMEFRAME_M1", None),
        "M5": getattr(gateway.mt5, "TIMEFRAME_M5", None),
        "M15": getattr(gateway.mt5, "TIMEFRAME_M15", None),
        "M30": getattr(gateway.mt5, "TIMEFRAME_M30", None),
        "H1": getattr(gateway.mt5, "TIMEFRAME_H1", None),
        "H4": getattr(gateway.mt5, "TIMEFRAME_H4", None),
        "D1": getattr(gateway.mt5, "TIMEFRAME_D1", None),
    }
    duration_ms = {
        "M1": 60_000,
        "M5": 5 * 60_000,
        "M15": 15 * 60_000,
        "M30": 30 * 60_000,
        "H1": 60 * 60_000,
        "H4": 4 * 60 * 60_000,
        "D1": 24 * 60 * 60_000,
    }
    mt5_timeframe = timeframe_map.get(timeframe_key)
    if mt5_timeframe is None:
        raise BridgeError(
            f"Unsupported timeframe {timeframe}",
            400,
            "TIMEFRAME_UNSUPPORTED",
        )

    broker_symbol = gateway._ensure_symbol(canonical_symbol)
    broker_start_ms = denormalize_timestamp_ms(start_ms)
    broker_end_ms = denormalize_timestamp_ms(end_ms)
    start = datetime.fromtimestamp(broker_start_ms / 1000.0, tz=timezone.utc)
    end = datetime.fromtimestamp(broker_end_ms / 1000.0, tz=timezone.utc)

    with gateway._lock:
        info = gateway._read_with_reconnect_locked("symbol_info", broker_symbol)
        rows = gateway._read_with_reconnect_locked(
            "copy_rates_range",
            broker_symbol,
            mt5_timeframe,
            start,
            end,
        )

    if info is None:
        raise BridgeError(
            f"No symbol specification for {broker_symbol}",
            404,
            "SYMBOL_NOT_FOUND",
        )
    if rows is None:
        raise BridgeError(
            f"copy_rates_range failed: {gateway.mt5.last_error()}",
            503,
            "CANDLES_UNAVAILABLE",
        )
    if len(rows) > max_bars:
        raise BridgeError(
            f"Candle history contains {len(rows)} bars; limit is {max_bars}",
            400,
            "CANDLE_RANGE_BAR_LIMIT",
        )

    point = float(getattr(info, "point", 0.0) or 0.0)
    broker_now_ms = denormalize_timestamp_ms(
        int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    )
    output: list[dict[str, Any]] = []
    for row in rows:
        open_time = int(row["time"]) * 1000
        close_time = open_time + duration_ms[timeframe_key]
        if close_time > broker_now_ms:
            continue
        try:
            spread_points = float(row["spread"])
        except Exception:
            spread_points = 0.0
        output.append(
            {
                "symbol": canonical_symbol,
                "brokerSymbol": broker_symbol,
                "timeframe": timeframe_key,
                "openTime": open_time,
                "closeTime": close_time,
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row["tick_volume"]),
                "spread": max(0.0, spread_points * point),
            }
        )

    return output
