from __future__ import annotations

import os
from typing import Any, Iterable

_MAX_ABS_OFFSET_SECONDS = 14 * 60 * 60


def broker_time_offset_seconds() -> int:
    """Return the configured broker-clock offset from real UTC.

    Some MT5 brokers expose server-local timestamps through Python as if they
    were Unix UTC timestamps. For example, a GMT+3 server can report values
    three hours in the future relative to the host UTC clock. A positive
    MT5_BROKER_TIME_OFFSET_SECONDS means raw MT5 timestamps are ahead of UTC
    and must be shifted backward before leaving the bridge.

    The default is zero, preserving normal MT5 Unix timestamp semantics. The
    value is deliberately explicit rather than auto-detected so stale weekend
    quotes or a bad Windows clock cannot silently rewrite market time.
    """

    raw = os.getenv("MT5_BROKER_TIME_OFFSET_SECONDS", "0").strip()
    try:
        value = int(raw or "0")
    except ValueError as exc:
        raise ValueError("MT5_BROKER_TIME_OFFSET_SECONDS must be an integer number of seconds") from exc

    if abs(value) > _MAX_ABS_OFFSET_SECONDS:
        raise ValueError(
            "MT5_BROKER_TIME_OFFSET_SECONDS exceeds the safety limit of +/-14 hours"
        )
    return value


def broker_time_offset_ms() -> int:
    return broker_time_offset_seconds() * 1000


def normalize_timestamp_ms(value: int | float) -> int:
    """Convert a raw broker pseudo-UTC timestamp to real Unix UTC milliseconds."""

    return int(value) - broker_time_offset_ms()


def denormalize_timestamp_ms(value: int | float) -> int:
    """Convert real Unix UTC milliseconds to the broker pseudo-UTC clock."""

    return int(value) + broker_time_offset_ms()


def normalize_quote(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(payload)
    if payload.get("timestamp") is not None:
        normalized["timestamp"] = normalize_timestamp_ms(payload["timestamp"])
    return normalized


def normalize_trading_day_boundary(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(payload)
    if payload.get("currentStartTime") is not None:
        normalized["currentStartTime"] = normalize_timestamp_ms(payload["currentStartTime"])
    if payload.get("previousStartTime") is not None:
        normalized["previousStartTime"] = normalize_timestamp_ms(payload["previousStartTime"])
    return normalized


def normalize_candles(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for row in rows:
        normalized = dict(row)
        if row.get("openTime") is not None:
            normalized["openTime"] = normalize_timestamp_ms(row["openTime"])
        if row.get("closeTime") is not None:
            normalized["closeTime"] = normalize_timestamp_ms(row["closeTime"])
        output.append(normalized)
    return output


def normalize_ticks(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for row in rows:
        normalized = dict(row)
        if row.get("timestamp") is not None:
            normalized["timestamp"] = normalize_timestamp_ms(row["timestamp"])
        output.append(normalized)
    return output


def normalize_deals(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for row in rows:
        normalized = dict(row)
        if row.get("timestamp") is not None:
            normalized["timestamp"] = normalize_timestamp_ms(row["timestamp"])
        output.append(normalized)
    return output


def normalize_positions(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for row in rows:
        normalized = dict(row)
        if row.get("openedAt") is not None:
            normalized["openedAt"] = normalize_timestamp_ms(row["openedAt"])
        output.append(normalized)
    return output
