"""Read-only broker snapshot adapter for V6 G2 shadow Auto Risk Lot (#76).

Collects fresh account, quote, multi-symbol mark prices, open positions, and
pending orders directly from a read-only MT5-compatible broker session and
delegates sizing to `scripts/v6_auto_lot_reprice_evaluator.py` (PR #97).

Safety & truthfulness invariants:
- NEVER imports MetaTrader5, NEVER calls `order_send`, NEVER mutates ARM/config.
- Always returns `executionEnabled=False` and `runtimePreSendAccepted=False`.
- Fails closed (`NO_TRADE`) if `account_info()`, `positions_get()`, `orders_get()`,
  or `symbol_info_tick(sym)` for the target symbol OR ANY open-position symbol is
  missing, returns `None`, is stale, or has inverted `ask < bid`.
- Uses side-accurate closing mark prices for open positions (`bid` for BUY,
  `ask` for SELL) across all symbols (including foreign symbols).
- Explicitly discloses `costProvenance` because MT5 tick/symbol APIs do not
  provide verified broker round-trip commission/slippage schedules.
"""
from __future__ import annotations

from math import isfinite

try:
    from scripts.v6_auto_lot_reprice_evaluator import (
        DEFAULT_MAX_SPREAD_POINTS,
        evaluate_auto_lot_candidate_from_snapshot,
    )
    from scripts.v6_auto_lot_shadow import MAX_QUOTE_AGE_SEC
except ImportError:
    from v6_auto_lot_reprice_evaluator import (
        DEFAULT_MAX_SPREAD_POINTS,
        evaluate_auto_lot_candidate_from_snapshot,
    )
    from v6_auto_lot_shadow import MAX_QUOTE_AGE_SEC


SNAPSHOT_ORIGIN_NOTE = "BROKER_SESSION_READONLY_ADAPTER_NO_ORDER_SEND"
COST_PROVENANCE_UNVERIFIED = "CALLER_SUPPLIED_COST_NOT_BROKER_API_VERIFIED"


def _num(value, *, positive: bool = False) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        x = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not isfinite(x) or (x <= 0 if positive else x < 0):
        return None
    return x


def _no_trade(code: str, reason: str, *, extra: dict | None = None) -> dict:
    payload = {
        "ok": False,
        "decision": "NO_TRADE",
        "mode": "AUTO_RISK_PERCENT_SHADOW",
        "executionEnabled": False,
        "runtimePreSendAccepted": False,
        "snapshotOrigin": SNAPSHOT_ORIGIN_NOTE,
        "costProvenance": COST_PROVENANCE_UNVERIFIED,
        "candidateVolume": None,
        "status": code,
        "reason": reason,
    }
    if extra:
        payload.update(extra)
    return payload


def _read_fresh_tick(broker, symbol: str, *, now_utc: float, max_quote_age_sec: float) -> dict | None:
    get_tick = getattr(broker, "symbol_info_tick", None)
    if not callable(get_tick):
        return None
    try:
        tick = get_tick(symbol)
    except Exception:
        return None
    if tick is None:
        return None
    bid = _num(getattr(tick, "bid", None), positive=True)
    ask = _num(getattr(tick, "ask", None), positive=True)
    ts = _num(getattr(tick, "time", None), positive=True)
    if None in (bid, ask, ts) or ask < bid:
        return None
    age = now_utc - ts
    if age < 0 or age > max_quote_age_sec:
        return None
    return {"bid": bid, "ask": ask, "timestampUtc": ts, "ageSec": round(age, 4)}


def _resolve_position_side(broker, raw_type) -> str | None:
    buy_code = getattr(broker, "POSITION_TYPE_BUY", getattr(broker, "ORDER_TYPE_BUY", None))
    sell_code = getattr(broker, "POSITION_TYPE_SELL", getattr(broker, "ORDER_TYPE_SELL", None))
    if (
        isinstance(raw_type, bool)
        or not isinstance(raw_type, int)
        or isinstance(buy_code, bool)
        or not isinstance(buy_code, int)
        or isinstance(sell_code, bool)
        or not isinstance(sell_code, int)
        or buy_code == sell_code
    ):
        return None
    if raw_type == buy_code:
        return "BUY"
    if raw_type == sell_code:
        return "SELL"
    return None


def _resolve_pending_side(raw_type) -> str | None:
    """Map standard MT5 pending order type codes (2/4/6=BUY, 3/5/7=SELL); fail-closed otherwise."""
    if isinstance(raw_type, bool) or not isinstance(raw_type, int):
        return None
    if raw_type in (2, 4, 6):
        return "BUY"
    if raw_type in (3, 5, 7):
        return "SELL"
    return None


def evaluate_auto_lot_from_broker_session(
    *,
    broker,
    expected_account_login: int,
    expected_server: str,
    symbol: str,
    side: str,
    now_utc: float,
    stop_loss_price: float,
    risk_percent: float,
    daily_remaining_risk_usd: float,
    commission_usd_per_lot: float,
    slippage_usd_per_lot: float = 0.0,
    allow_zero_cost: bool = False,
    max_spread_points: float = DEFAULT_MAX_SPREAD_POINTS,
    max_quote_age_sec: float = MAX_QUOTE_AGE_SEC,
    dca_layer: bool = False,
) -> dict:
    """Read live account, ticks, open positions, and pending orders from a read-only broker session."""
    now_val = _num(now_utc, positive=True)
    max_age = _num(max_quote_age_sec, positive=True)
    sym = str(symbol or "").strip()
    if now_val is None or max_age is None or not sym:
        return _no_trade("BLOCKED_INVALID_INTENT", "Valid symbol, now_utc, and max_quote_age_sec required")

    get_account = getattr(broker, "account_info", None)
    get_positions = getattr(broker, "positions_get", None)
    get_orders = getattr(broker, "orders_get", None)
    if not (callable(get_account) and callable(get_positions) and callable(get_orders)):
        return _no_trade("BLOCKED_BROKER_API_UNAVAILABLE", "Read-only broker snapshot APIs unavailable")

    try:
        account = get_account()
    except Exception:
        return _no_trade("BLOCKED_ACCOUNT_UNVERIFIED", "Broker account_info() failed")
    if account is None:
        return _no_trade("BLOCKED_ACCOUNT_UNVERIFIED", "Broker account_info() returned None")

    primary_tick = _read_fresh_tick(broker, sym, now_utc=now_val, max_quote_age_sec=max_age)
    if primary_tick is None:
        return _no_trade("BLOCKED_QUOTE_UNVERIFIED", f"Fresh broker tick unavailable for {sym}")

    try:
        raw_positions = get_positions()
    except Exception:
        return _no_trade("BLOCKED_OPEN_EXPOSURE_UNVERIFIED", "Broker positions_get() failed")
    if not isinstance(raw_positions, (list, tuple)):
        return _no_trade("BLOCKED_OPEN_EXPOSURE_UNVERIFIED", "Broker positions_get() returned non-list/None")

    tick_cache: dict[str, dict] = {sym.casefold(): primary_tick}
    normalized_positions: list[dict] = []
    for pos in raw_positions:
        pos_sym = str(getattr(pos, "symbol", "") or "").strip()
        pos_side = _resolve_position_side(broker, getattr(pos, "type", None))
        pos_vol = _num(getattr(pos, "volume", None), positive=True)
        pos_entry = _num(getattr(pos, "price_open", None), positive=True)
        pos_sl = _num(getattr(pos, "sl", None), positive=True)
        if not pos_sym or pos_side is None or None in (pos_vol, pos_entry, pos_sl):
            return _no_trade("BLOCKED_OPEN_EXPOSURE_UNVERIFIED", "Incomplete or unverified open position record")

        cache_key = pos_sym.casefold()
        if cache_key not in tick_cache:
            sym_tick = _read_fresh_tick(broker, pos_sym, now_utc=now_val, max_quote_age_sec=max_age)
            if sym_tick is None:
                return _no_trade(
                    "BLOCKED_OPEN_POSITION_MARK_UNVERIFIED",
                    f"Fresh broker mark tick unavailable for open symbol {pos_sym}",
                )
            tick_cache[cache_key] = sym_tick

        sym_tick = tick_cache[cache_key]
        mark_price = sym_tick["bid"] if pos_side == "BUY" else sym_tick["ask"]
        normalized_positions.append({
            "symbol": pos_sym,
            "side": pos_side,
            "volume": pos_vol,
            "price_open": pos_entry,
            "sl": pos_sl,
            "mark_price": mark_price,
        })

    try:
        raw_orders = get_orders()
    except Exception:
        return _no_trade("BLOCKED_PENDING_EXPOSURE_UNVERIFIED", "Broker orders_get() failed")
    if not isinstance(raw_orders, (list, tuple)):
        return _no_trade("BLOCKED_PENDING_EXPOSURE_UNVERIFIED", "Broker orders_get() returned non-list/None")

    normalized_pending: list[dict] = []
    for order in raw_orders:
        ord_sym = str(getattr(order, "symbol", "") or "").strip()
        ord_side = _resolve_pending_side(getattr(order, "type", None))
        vol_raw = getattr(order, "volume_current", None)
        if vol_raw is None:
            vol_raw = getattr(order, "volume_initial", None)
        ord_vol = _num(vol_raw, positive=True)
        ord_entry = _num(getattr(order, "price_open", None), positive=True)
        ord_sl = _num(getattr(order, "sl", None), positive=True)
        if not ord_sym or ord_side is None or None in (ord_vol, ord_entry, ord_sl):
            return _no_trade("BLOCKED_PENDING_EXPOSURE_UNVERIFIED", "Incomplete or unverified pending order record")
        normalized_pending.append({
            "symbol": ord_sym,
            "side": ord_side,
            "volume": ord_vol,
            "price_open": ord_entry,
            "sl": ord_sl,
        })

    res = evaluate_auto_lot_candidate_from_snapshot(
        broker=broker,
        account=account,
        expected_account_login=expected_account_login,
        expected_server=expected_server,
        symbol=sym,
        side=side,
        quote=primary_tick,
        now_utc=now_val,
        stop_loss_price=stop_loss_price,
        risk_percent=risk_percent,
        broker_positions=normalized_positions,
        broker_pending_orders=normalized_pending,
        daily_remaining_risk_usd=daily_remaining_risk_usd,
        commission_usd_per_lot=commission_usd_per_lot,
        slippage_usd_per_lot=slippage_usd_per_lot,
        allow_zero_cost=allow_zero_cost,
        max_spread_points=max_spread_points,
        max_quote_age_sec=max_age,
        dca_layer=dca_layer,
    )
    res["snapshotOrigin"] = SNAPSHOT_ORIGIN_NOTE
    res["costProvenance"] = COST_PROVENANCE_UNVERIFIED
    res["observedTickSymbols"] = sorted(tick_cache.keys())
    res["executionEnabled"] = False
    res["runtimePreSendAccepted"] = False
    return res
