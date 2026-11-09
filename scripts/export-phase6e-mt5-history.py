from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any

try:
    import MetaTrader5 as mt5
except ImportError as exc:
    print(f"PHASE6E_CHUNK_EXPORT_FAIL:MetaTrader5 unavailable:{exc}", file=sys.stderr)
    raise SystemExit(2)

DAY_MS = 24 * 60 * 60 * 1000
DATASET_OFFSET_MS = 3 * 60 * 60 * 1000
CHUNK_DAYS = 30


def load_env_file(path: str | None) -> None:
    if not path:
        return
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Bridge env not found: {p}")
    for raw in p.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


def env_int(name: str) -> int | None:
    raw = os.getenv(name, "").strip()
    return int(raw) if raw else None


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def required_path(name: str) -> Path:
    raw = os.getenv(name, "").strip()
    if not raw:
        raise ValueError(f"Missing required env {name}")
    return Path(raw)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def initialize() -> None:
    kwargs: dict[str, Any] = {
        "timeout": int(os.getenv("MT5_INITIALIZE_TIMEOUT_MS", "60000")),
        "portable": env_bool("MT5_PORTABLE", False),
    }
    terminal_path = os.getenv("MT5_TERMINAL_PATH", "").strip()
    login = env_int("MT5_LOGIN")
    password = os.getenv("MT5_PASSWORD", "").strip()
    server = os.getenv("MT5_SERVER", "").strip()
    if terminal_path:
        kwargs["path"] = terminal_path
    if login is not None:
        kwargs["login"] = login
    if password:
        kwargs["password"] = password
    if server:
        kwargs["server"] = server
    if not mt5.initialize(**kwargs):
        raise RuntimeError(f"initialize:{mt5.last_error()}")


def broker_symbol(canonical: str) -> str:
    raw = os.getenv("MT5_SYMBOL_MAP_JSON", "").strip()
    mapping = json.loads(raw) if raw else {"XAUUSD": "XAUUSD"}
    if not isinstance(mapping, dict):
        raise ValueError("MT5_SYMBOL_MAP_JSON must be a JSON object")
    return str(mapping.get(canonical, canonical))


def ensure_symbol(symbol: str) -> Any:
    info = mt5.symbol_info(symbol)
    if info is None:
        raise RuntimeError(f"symbol_info:{symbol}:{mt5.last_error()}")
    if not bool(getattr(info, "visible", True)):
        if not mt5.symbol_select(symbol, True):
            raise RuntimeError(f"symbol_select:{symbol}:{mt5.last_error()}")
        info = mt5.symbol_info(symbol)
        if info is None:
            raise RuntimeError(f"symbol_info_after_select:{symbol}:{mt5.last_error()}")
    return info


def copy_range_chunked(symbol: str, timeframe: int, start: datetime, end: datetime, label: str) -> list[Any]:
    by_time: dict[int, Any] = {}
    cursor = start
    chunk = timedelta(days=CHUNK_DAYS)
    chunk_no = 0
    while cursor < end:
        chunk_no += 1
        chunk_end = min(end, cursor + chunk)
        rows = mt5.copy_rates_range(symbol, timeframe, cursor, chunk_end)
        if rows is None:
            raise RuntimeError(
                f"rates_range:{label}:chunk={chunk_no}:from={cursor.isoformat()}:to={chunk_end.isoformat()}:{mt5.last_error()}"
            )
        for row in rows:
            by_time[int(row["time"])] = row
        print(
            f"PHASE6E_CHUNK_EXPORT_{label}_CHUNK={chunk_no}|FROM={cursor.isoformat()}|TO={chunk_end.isoformat()}|ROWS={len(rows)}"
        )
        cursor = chunk_end
    return [by_time[key] for key in sorted(by_time)]


def to_bar(row: Any, timeframe_ms: int) -> dict[str, Any]:
    # MQL5 Python documents bar timestamps in UTC. The existing project replay
    # coordinate is broker +03 encoded as epoch-like milliseconds, so Phase 6E
    # deliberately shifts UTC bars by the locked +03 dataset offset.
    open_ms = int(row["time"]) * 1000 + DATASET_OFFSET_MS
    return {
        "openTime": open_ms,
        "closeTime": open_ms + timeframe_ms,
        "open": float(row["open"]),
        "high": float(row["high"]),
        "low": float(row["low"]),
        "close": float(row["close"]),
        "volume": float(row["tick_volume"]),
    }


def effective_tick_value_per_lot(symbol: str, info: Any) -> float:
    tick_size = float(getattr(info, "trade_tick_size", 0.0) or getattr(info, "point", 0.0))
    tick = mt5.symbol_info_tick(symbol)
    price = float(getattr(tick, "ask", 0.0) or getattr(tick, "bid", 0.0) or 0.0) if tick else 0.0
    if tick_size > 0 and price > 0:
        value = mt5.order_calc_profit(mt5.ORDER_TYPE_BUY, symbol, 1.0, price, price + tick_size)
        if value is not None and abs(float(value)) > 0:
            return abs(float(value))
    for attr in ("trade_tick_value_profit", "trade_tick_value", "trade_tick_value_loss"):
        value = float(getattr(info, attr, 0.0) or 0.0)
        if value > 0:
            return value
    raise RuntimeError("Unable to determine effective tick value per lot")


def main() -> int:
    try:
        load_env_file(os.getenv("ZIQ_BRIDGE_ENV"))
        days = int(os.getenv("ZIQ_DAYS", "730"))
        if days < 1:
            raise ValueError("ZIQ_DAYS must be >= 1")
        out_m15 = required_path("ZIQ_M15_JSON")
        out_m5 = required_path("ZIQ_M5_JSON")
        out_meta = required_path("ZIQ_META_JSON")
        result_raw = os.getenv("ZIQ_RESULT_JSON", "").strip()
        out_result = Path(result_raw) if result_raw else None

        initialize()
        canonical = "XAUUSD"
        symbol = broker_symbol(canonical)
        info = ensure_symbol(symbol)
        account = mt5.account_info()

        now = datetime.now(timezone.utc)
        start = now - timedelta(days=days)
        print(f"PHASE6E_CHUNK_EXPORT_SYMBOL={symbol}")
        print(f"PHASE6E_CHUNK_EXPORT_FROM_UTC={start.isoformat()}")
        print(f"PHASE6E_CHUNK_EXPORT_TO_UTC={now.isoformat()}")
        print(f"PHASE6E_CHUNK_EXPORT_CHUNK_DAYS={CHUNK_DAYS}")

        m15_rows = copy_range_chunked(symbol, mt5.TIMEFRAME_M15, start, now, "M15")
        m5_rows = copy_range_chunked(symbol, mt5.TIMEFRAME_M5, start, now, "M5")
        if not m15_rows or not m5_rows:
            raise RuntimeError("MT5 returned empty M15 or M5 history")

        m15 = [to_bar(row, 15 * 60_000) for row in m15_rows]
        m5 = [to_bar(row, 5 * 60_000) for row in m5_rows]
        point = float(getattr(info, "point", 0.0) or 0.0)
        tick_size = float(getattr(info, "trade_tick_size", 0.0) or point)
        tick_value = effective_tick_value_per_lot(symbol, info)
        min_volume = float(getattr(info, "volume_min", 0.01) or 0.01)
        max_volume = float(getattr(info, "volume_max", 100.0) or 100.0)
        volume_step = float(getattr(info, "volume_step", min_volume) or min_volume)
        spread_map_raw = os.getenv("MT5_MAX_SPREAD_POINTS_JSON", "").strip()
        spread_map = json.loads(spread_map_raw) if spread_map_raw else {canonical: 50}
        max_spread_points = float(spread_map.get(canonical, 50)) if isinstance(spread_map, dict) else 50.0

        meta = {
            "symbol": canonical,
            "brokerSymbol": symbol,
            "digits": int(getattr(info, "digits", 0) or 0),
            "point": point,
            "tickSize": tick_size,
            "effectiveTickValuePerLot": tick_value,
            "contractSize": float(getattr(info, "trade_contract_size", 0.0) or 0.0),
            "minVolume": min_volume,
            "maxVolume": max_volume,
            "volumeStep": volume_step,
            "maxSpreadPoints": max_spread_points,
            "maxSpreadPrice": max_spread_points * point,
            "leverage": int(getattr(account, "leverage", 0) or 0) if account else 0,
            "currency": str(getattr(account, "currency", "USD") or "USD") if account else "USD",
            "m15Count": len(m15),
            "m5Count": len(m5),
            "historyDaysRequested": days,
            "chunkDays": CHUNK_DAYS,
            "sourceTimestampTimezone": "UTC",
            "datasetOffsetMs": DATASET_OFFSET_MS,
            "source": "PHASE6E_MT5_COPY_RATES_RANGE_CHUNKED",
        }

        write_json(out_m15, m15)
        write_json(out_m5, m5)
        write_json(out_meta, meta)
        if out_result is not None:
            write_json(out_result, {"ok": True, "m15Count": len(m15), "m5Count": len(m5)})

        print(f"EXPORT_M15_COUNT={len(m15)}")
        print(f"EXPORT_M5_COUNT={len(m5)}")
        print(f"EFFECTIVE_TICK_VALUE_PER_LOT={tick_value:.8f}")
        print("TICK_VALUE_SOURCE=ORDER_CALC_PROFIT_OR_SYMBOL_INFO")
        print(f"BROKER_HOST_OFFSET_MS={DATASET_OFFSET_MS}")
        print(f"PHASE6E_CHUNK_EXPORT_DATASET_OFFSET_MS={DATASET_OFFSET_MS}")
        print("PHASE6E_CHUNK_EXPORT_STATUS=PASS")
        return 0
    except Exception as exc:
        print(f"PHASE6E_CHUNK_EXPORT_FAIL:{exc}", file=sys.stderr)
        try:
            print(f"PHASE6E_CHUNK_EXPORT_MT5_LAST_ERROR={mt5.last_error()}", file=sys.stderr)
        except Exception:
            pass
        return 1
    finally:
        try:
            mt5.shutdown()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
