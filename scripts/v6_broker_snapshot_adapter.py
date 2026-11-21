"""Read-only, non-atomic best-effort broker snapshot adapter for V6 G2 (#76).

Collects account, quote, multi-symbol mark prices, open positions, and pending
orders from a read-only MT5-compatible broker session and delegates sizing to
`scripts/v6_auto_lot_reprice_evaluator.py` (PR #97).

Safety & truthfulness invariants:
- NEVER imports MetaTrader5, NEVER calls `order_send`, NEVER mutates ARM/config.
- Always returns `executionEnabled=False`, `runtimePreSendAccepted=False`, and
  `snapshotOrigin="READONLY_NONATOMIC_BEST_EFFORT_BROKER_SNAPSHOT"`.
- Cross-call race mitigation (best-effort, non-atomic): re-reads `account_info()`,
  `positions_get()`, and `orders_get()` before and after tick collection and
  fails closed (`NO_TRADE`) if account identity/equity/margin OR any position/order
  field (`ticket`, `symbol`, `type`, `volume`, `price_open`, `sl`) drifts.
- Wraps all broker API calls and attribute reads to return `NO_TRADE` on error.
- Verifies pending order type codes against broker `ORDER_TYPE_*` constants.
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


SNAPSHOT_ORIGIN_NOTE = "READONLY_NONATOMIC_BEST_EFFORT_BROKER_SNAPSHOT"
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


def _read_account_fingerprint(broker) -> tuple[object, tuple[int, str, float, float]] | None:
    get_account = getattr(broker, "account_info", None)
    if not callable(get_account):
        return None
    try:
        acc = get_account()
        if acc is None:
            return None
        login = int(getattr(acc, "login", 0))
        server = str(getattr(acc, "server", "") or "").strip()
        equity = _num(getattr(acc, "equity", None), positive=True)
        free_margin = _num(getattr(acc, "margin_free", None), positive=True)
    except Exception:
        return None
    if login <= 0 or not server or equity is None or free_margin is None:
        return None
    return acc, (login, server.casefold(), round(equity, 8), round(free_margin, 8))


def _read_fresh_tick(broker, symbol: str, *, now_utc: float, max_quote_age_sec: float) -> dict | None:
    get_tick = getattr(broker, "symbol_info_tick", None)
    if not callable(get_tick):
        return None
    try:
        tick = get_tick(symbol)
        if tick is None:
            return None
        bid = _num(getattr(tick, "bid", None), positive=True)
        ask = _num(getattr(tick, "ask", None), positive=True)
        ts = _num(getattr(tick, "time", None), positive=True)
    except Exception:
        return None
    if None in (bid, ask, ts) or ask < bid:
        return None
    age = now_utc - ts
    if age < 0 or age > max_quote_age_sec:
        return None
    return {"bid": bid, "ask": ask, "timestampUtc": ts, "ageSec": round(age, 4)}


def _resolve_position_side(broker, raw_type) -> str | None:
    try:
        buy_code = getattr(broker, "POSITION_TYPE_BUY", getattr(broker, "ORDER_TYPE_BUY", None))
        sell_code = getattr(broker, "POSITION_TYPE_SELL", getattr(broker, "ORDER_TYPE_SELL", None))
    except Exception:
        return None
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


def _resolve_pending_side(broker, raw_type) -> str | None:
    """Resolve pending order side using explicit broker ORDER_TYPE_* constants."""
    if isinstance(raw_type, bool) or not isinstance(raw_type, int):
        return None

    buy_consts = ("ORDER_TYPE_BUY_LIMIT", "ORDER_TYPE_BUY_STOP", "ORDER_TYPE_BUY_STOP_LIMIT")
    sell_consts = ("ORDER_TYPE_SELL_LIMIT", "ORDER_TYPE_SELL_STOP", "ORDER_TYPE_SELL_STOP_LIMIT")
    default_buy = (2, 4, 6)
    default_sell = (3, 5, 7)

    buy_codes: set[int] = set()
    sell_codes: set[int] = set()
    try:
        for name, default_val in zip(buy_consts, default_buy):
            val = getattr(broker, name, None)
            if val is not None:
                if isinstance(val, bool) or not isinstance(val, int) or val < 0:
                    return None
                buy_codes.add(val)
            else:
                buy_codes.add(default_val)
        for name, default_val in zip(sell_consts, default_sell):
            val = getattr(broker, name, None)
            if val is not None:
                if isinstance(val, bool) or not isinstance(val, int) or val < 0:
                    return None
                sell_codes.add(val)
            else:
                sell_codes.add(default_val)
    except Exception:
        return None

    if buy_codes & sell_codes:
        return None
    if raw_type in buy_codes:
        return "BUY"
    if raw_type in sell_codes:
        return "SELL"
    return None


def _snapshot_positions(broker) -> tuple[list[tuple], list[dict]] | None:
    get_positions = getattr(broker, "positions_get", None)
    if not callable(get_positions):
        return None
    try:
        raw_positions = get_positions()
    except Exception:
        return None
    if not isinstance(raw_positions, (list, tuple)):
        return None

    identities: list[tuple] = []
    records: list[dict] = []
    for idx, pos in enumerate(raw_positions):
        try:
            pos_ticket = getattr(pos, "ticket", getattr(pos, "identifier", idx))
            pos_sym = str(getattr(pos, "symbol", "") or "").strip()
            raw_type = getattr(pos, "type", None)
            pos_side = _resolve_position_side(broker, raw_type)
            pos_vol = _num(getattr(pos, "volume", None), positive=True)
            pos_entry = _num(getattr(pos, "price_open", None), positive=True)
            pos_sl = _num(getattr(pos, "sl", None), positive=True)
        except Exception:
            return None
        if not pos_sym or pos_side is None or None in (pos_vol, pos_entry, pos_sl):
            return None
        identities.append((pos_ticket, pos_sym.casefold(), raw_type, round(pos_vol, 8), round(pos_entry, 6), round(pos_sl, 6)))
        records.append({
            "symbol": pos_sym,
            "side": pos_side,
            "volume": pos_vol,
            "price_open": pos_entry,
            "sl": pos_sl,
        })
    identities.sort()
    return identities, records


def _snapshot_pending_orders(broker) -> tuple[list[tuple], list[dict]] | None:
    get_orders = getattr(broker, "orders_get", None)
    if not callable(get_orders):
        return None
    try:
        raw_orders = get_orders()
    except Exception:
        return None
    if not isinstance(raw_orders, (list, tuple)):
        return None

    identities: list[tuple] = []
    records: list[dict] = []
    for idx, order in enumerate(raw_orders):
        try:
            ord_ticket = getattr(order, "ticket", idx)
            ord_sym = str(getattr(order, "symbol", "") or "").strip()
            raw_type = getattr(order, "type", None)
            ord_side = _resolve_pending_side(broker, raw_type)
            vol_raw = getattr(order, "volume_current", None)
            if vol_raw is None:
                vol_raw = getattr(order, "volume_initial", None)
            ord_vol = _num(vol_raw, positive=True)
            ord_entry = _num(getattr(order, "price_open", None), positive=True)
            ord_sl = _num(getattr(order, "sl", None), positive=True)
        except Exception:
            return None
        if not ord_sym or ord_side is None or None in (ord_vol, ord_entry, ord_sl):
            return None
        identities.append((ord_ticket, ord_sym.casefold(), raw_type, round(ord_vol, 8), round(ord_entry, 6), round(ord_sl, 6)))
        records.append({
            "symbol": ord_sym,
            "side": ord_side,
            "volume": ord_vol,
            "price_open": ord_entry,
            "sl": ord_sl,
        })
    identities.sort()
    return identities, records


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
    """Read live account, ticks, open positions, and pending orders with drift checks."""
    try:
        now_val = _num(now_utc, positive=True)
        max_age = _num(max_quote_age_sec, positive=True)
        sym = str(symbol or "").strip()
        if now_val is None or max_age is None or not sym:
            return _no_trade("BLOCKED_INVALID_INTENT", "Valid symbol, now_utc, and max_quote_age_sec required")

        acc_first = _read_account_fingerprint(broker)
        if acc_first is None:
            return _no_trade("BLOCKED_ACCOUNT_UNVERIFIED", "Broker account_info() unavailable or invalid")
        account_obj, fp_first = acc_first

        primary_tick = _read_fresh_tick(broker, sym, now_utc=now_val, max_quote_age_sec=max_age)
        if primary_tick is None:
            return _no_trade("BLOCKED_QUOTE_UNVERIFIED", f"Fresh broker tick unavailable for {sym}")

        pos_first = _snapshot_positions(broker)
        if pos_first is None:
            return _no_trade("BLOCKED_OPEN_EXPOSURE_UNVERIFIED", "Broker positions_get() unavailable or invalid")
        pos_ids_first, normalized_positions = pos_first

        ord_first = _snapshot_pending_orders(broker)
        if ord_first is None:
            return _no_trade("BLOCKED_PENDING_EXPOSURE_UNVERIFIED", "Broker orders_get() unavailable or invalid")
        ord_ids_first, normalized_pending = ord_first

        tick_cache: dict[str, dict] = {sym.casefold(): primary_tick}
        for pos in normalized_positions:
            pos_sym = pos["symbol"]
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
            pos["mark_price"] = sym_tick["bid"] if pos["side"] == "BUY" else sym_tick["ask"]

        acc_second = _read_account_fingerprint(broker)
        if acc_second is None:
            return _no_trade("BLOCKED_ACCOUNT_UNVERIFIED", "Broker account_info() unavailable on re-check")
        if acc_second[1] != fp_first:
            return _no_trade("BLOCKED_ACCOUNT_SNAPSHOT_CHANGED", "Broker account state changed during snapshot collection")

        pos_second = _snapshot_positions(broker)
        if pos_second is None:
            return _no_trade("BLOCKED_OPEN_EXPOSURE_UNVERIFIED", "Broker positions_get() unavailable on re-check")
        if pos_second[0] != pos_ids_first:
            return _no_trade("BLOCKED_INVENTORY_SNAPSHOT_DRIFT", "Open positions changed during snapshot collection")

        ord_second = _snapshot_pending_orders(broker)
        if ord_second is None:
            return _no_trade("BLOCKED_PENDING_EXPOSURE_UNVERIFIED", "Broker orders_get() unavailable on re-check")
        if ord_second[0] != ord_ids_first:
            return _no_trade("BLOCKED_INVENTORY_SNAPSHOT_DRIFT", "Pending orders changed during snapshot collection")

        res = evaluate_auto_lot_candidate_from_snapshot(
            broker=broker,
            account=account_obj,
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
    except Exception:
        return _no_trade("BLOCKED_BROKER_ADAPTER_ERROR", "Unexpected error while reading broker snapshot")
