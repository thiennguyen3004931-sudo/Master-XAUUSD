"""Offline/read-only broker-priced Auto Risk Lot evaluator & pre-send repricer (G2, #76).

Builds on `scripts/v6_auto_lot_shadow.py` (PR #85 / #93) without modifying it and
WITHOUT routing into LIVE execution (`executionEnabled` is always `False`).
"""
from __future__ import annotations

from math import isfinite

try:
    from scripts.v6_auto_lot_shadow import (
        ADVERSE_GAP_BUFFER,
        MAX_QUOTE_AGE_SEC,
        recommend_broker_auto_lot_shadow,
    )
except ImportError:
    from v6_auto_lot_shadow import (
        ADVERSE_GAP_BUFFER,
        MAX_QUOTE_AGE_SEC,
        recommend_broker_auto_lot_shadow,
    )

DEFAULT_MAX_SPREAD_POINTS = 65.0

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


def _positive_int(value) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        n = int(value)
        if n <= 0 or str(n) != str(value).strip():
            return None
        return n
    except (TypeError, ValueError, OverflowError):
        return None


def _no_trade(code: str, reason: str, *, extra: dict | None = None) -> dict:
    payload = {
        "ok": False,
        "decision": "NO_TRADE",
        "mode": "AUTO_RISK_PERCENT_SHADOW",
        "executionEnabled": False,
        "candidateVolume": None,
        "status": code,
        "reason": reason,
    }
    if extra:
        payload.update(extra)
    return payload


def _resolve_order_types(broker) -> tuple[int, int] | None:
    buy_type = getattr(broker, "ORDER_TYPE_BUY", None)
    sell_type = getattr(broker, "ORDER_TYPE_SELL", None)
    if (
        not isinstance(buy_type, int)
        or isinstance(buy_type, bool)
        or not isinstance(sell_type, int)
        or isinstance(sell_type, bool)
        or buy_type < 0
        or sell_type < 0
        or buy_type == sell_type
    ):
        return None
    return buy_type, sell_type


def _price_exposure_collection(broker, items, *, buy_type: int, sell_type: int) -> float | None:
    if not isinstance(items, (list, tuple)):
        return None
    calc_profit = getattr(broker, "order_calc_profit", None)
    if not callable(calc_profit):
        return None
    total_risk = 0.0
    for item in items:
        if not isinstance(item, dict):
            return None
        sym = str(item.get("symbol") or "").strip()
        side = str(item.get("side") or "").strip().upper()
        vol = _num(item.get("volume"), positive=True)
        entry = _num(item.get("price_open"), positive=True)
        sl = _num(item.get("sl"), positive=True)
        if not sym or side not in ("BUY", "SELL") or None in (vol, entry, sl):
            return None
        if (side == "BUY" and sl >= entry) or (side == "SELL" and sl <= entry):
            return None
        order_type = buy_type if side == "BUY" else sell_type
        try:
            pnl = float(calc_profit(order_type, sym, vol, entry, sl))
        except Exception:
            return None
        if not isfinite(pnl) or pnl >= 0:
            return None
        total_risk += (-pnl) * ADVERSE_GAP_BUFFER
    return round(total_risk, 6)
def evaluate_auto_lot_candidate_from_snapshot(
    *,
    broker,
    account,
    expected_account_login: int,
    expected_server: str,
    symbol: str,
    side: str,
    quote: dict,
    now_utc: float,
    stop_loss_price: float,
    risk_percent: float,
    broker_positions,
    broker_pending_orders,
    daily_remaining_risk_usd: float,
    commission_usd_per_lot: float,
    slippage_usd_per_lot: float = 0.0,
    max_spread_points: float = DEFAULT_MAX_SPREAD_POINTS,
    max_quote_age_sec: float = MAX_QUOTE_AGE_SEC,
    dca_layer: bool = False,
) -> dict:
    exp_login = _positive_int(expected_account_login)
    exp_server = str(expected_server or "").strip()
    sym = str(symbol or "").strip()
    side_norm = str(side or "").strip().upper()
    if exp_login is None or not exp_server or not sym or side_norm not in ("BUY", "SELL"):
        return _no_trade("BLOCKED_INVALID_INTENT", "Explicit account, server, symbol and BUY/SELL required")
    try:
        live_login = _positive_int(getattr(account, "login", None))
        live_server = str(getattr(account, "server", "") or "").strip()
    except Exception:
        return _no_trade("BLOCKED_ACCOUNT_UNVERIFIED", "Broker account snapshot unavailable")
    if live_login != exp_login or not live_server or live_server.casefold() != exp_server.casefold():
        return _no_trade("BLOCKED_ACCOUNT_SERVER_MISMATCH", "Live broker account/server does not match bound session identity")
    order_types = _resolve_order_types(broker)
    if order_types is None:
        return _no_trade("BLOCKED_BROKER_ORDER_TYPE_UNVERIFIED", "Broker BUY/SELL order-type constants are missing or invalid")
    buy_type, sell_type = order_types
    if not isinstance(quote, dict):
        return _no_trade("BLOCKED_QUOTE_UNVERIFIED", "Broker quote snapshot missing")
    bid = _num(quote.get("bid"), positive=True)
    ask = _num(quote.get("ask"), positive=True)
    quote_ts = _num(quote.get("timestampUtc"), positive=True)
    now_val = _num(now_utc, positive=True)
    max_age = _num(max_quote_age_sec, positive=True)
    max_spread = _num(max_spread_points, positive=True)
    if None in (bid, ask, quote_ts, now_val, max_age, max_spread) or ask < bid:
        return _no_trade("BLOCKED_QUOTE_UNVERIFIED", "Invalid Bid/Ask or quote timestamp")
    quote_age = now_val - quote_ts
    if quote_age < 0 or quote_age > max_age:
        return _no_trade("BLOCKED_QUOTE_STALE", f"Quote age {quote_age:.2f}s outside [0, {max_age:.2f}]s")
    try:
        meta = broker.symbol_info(sym)
        point = _num(getattr(meta, "point", None), positive=True)
        meta_name = str(getattr(meta, "name", sym) or sym).strip()
    except Exception:
        return _no_trade("BLOCKED_SYMBOL_UNVERIFIED", "Broker symbol metadata unavailable")
    if point is None or meta_name.casefold() != sym.casefold():
        return _no_trade("BLOCKED_SYMBOL_UNVERIFIED", "Broker symbol point/name unverified")
    spread_points = round((ask - bid) / point, 4)
    if not isfinite(spread_points) or spread_points > max_spread:
        return _no_trade("BLOCKED_SPREAD_JUMP", f"Spread {spread_points:.2f} pts exceeds ceiling {max_spread:.2f} pts", extra={"spreadPoints": spread_points})
    comm = _num(commission_usd_per_lot)
    slip = _num(slippage_usd_per_lot)
    if comm is None or slip is None:
        return _no_trade("BLOCKED_COST_UNVERIFIED", "Commission and slippage per lot must be explicit >= 0")
    open_risk = _price_exposure_collection(broker, broker_positions, buy_type=buy_type, sell_type=sell_type)
    if open_risk is None:
        return _no_trade("BLOCKED_OPEN_EXPOSURE_UNVERIFIED", "Open position SL risk could not be verified")
    pending_risk = _price_exposure_collection(broker, broker_pending_orders, buy_type=buy_type, sell_type=sell_type)
    if pending_risk is None:
        return _no_trade("BLOCKED_PENDING_EXPOSURE_UNVERIFIED", "Pending order SL risk could not be verified")
    entry_price = ask if side_norm == "BUY" else bid
    shadow_res = recommend_broker_auto_lot_shadow(
        broker,
        account,
        sym,
        side_norm,
        entry_price,
        stop_loss_price,
        risk_percent,
        quote_fresh=True,
        quote_age_seconds=quote_age,
        existing_sl_risk_usd=open_risk,
        pending_sl_risk_usd=pending_risk,
        daily_remaining_risk_usd=daily_remaining_risk_usd,
        costs_usd_per_lot=round(comm + slip, 6),
        risk_inputs_verified=True,
        costs_verified=True,
        dca_layer=dca_layer,
    )
    if not shadow_res.get("ok"):
        return _no_trade(
            str(shadow_res.get("status") or "BLOCKED_SHADOW_REJECTED"),
            str(shadow_res.get("reason") or "Shadow auto-lot rejected"),
            extra={"spreadPoints": spread_points, "openRiskUsd": open_risk, "pendingRiskUsd": pending_risk},
        )
    return {
        **shadow_res,
        "decision": "SHADOW_CANDIDATE_ONLY",
        "executionEnabled": False,
        "entryPrice": entry_price,
        "spreadPoints": spread_points,
        "openRiskUsd": open_risk,
        "pendingRiskUsd": pending_risk,
        "combinedExistingRiskUsd": round(open_risk + pending_risk, 6),
    }
def reprice_auto_lot_before_send(
    *,
    initial_candidate: dict,
    broker,
    account,
    expected_account_login: int,
    expected_server: str,
    symbol: str,
    side: str,
    fresh_quote: dict,
    now_utc: float,
    stop_loss_price: float,
    risk_percent: float,
    broker_positions,
    broker_pending_orders,
    daily_remaining_risk_usd: float,
    commission_usd_per_lot: float,
    slippage_usd_per_lot: float = 0.0,
    max_spread_points: float = DEFAULT_MAX_SPREAD_POINTS,
    max_quote_age_sec: float = MAX_QUOTE_AGE_SEC,
    partial_fill_existing_volume: float = 0.0,
) -> dict:
    if not isinstance(initial_candidate, dict) or not initial_candidate.get("ok"):
        return _no_trade("BLOCKED_INITIAL_CANDIDATE_INVALID", "Initial shadow candidate is not valid")
    initial_vol = _num(initial_candidate.get("candidateVolume"), positive=True)
    filled_vol = _num(partial_fill_existing_volume)
    if initial_vol is None or filled_vol is None:
        return _no_trade("BLOCKED_INITIAL_CANDIDATE_INVALID", "Invalid initial or partial-fill volume")
    if filled_vol > 0:
        return _no_trade(
            "BLOCKED_PARTIAL_FILL_RECONCILIATION_REQUIRED",
            "Partial fill already observed; do not auto-top-up or resend without reconciliation",
            extra={"observedPartialVolume": filled_vol},
        )
    fresh = evaluate_auto_lot_candidate_from_snapshot(
        broker=broker,
        account=account,
        expected_account_login=expected_account_login,
        expected_server=expected_server,
        symbol=symbol,
        side=side,
        quote=fresh_quote,
        now_utc=now_utc,
        stop_loss_price=stop_loss_price,
        risk_percent=risk_percent,
        broker_positions=broker_positions,
        broker_pending_orders=broker_pending_orders,
        daily_remaining_risk_usd=daily_remaining_risk_usd,
        commission_usd_per_lot=commission_usd_per_lot,
        slippage_usd_per_lot=slippage_usd_per_lot,
        max_spread_points=max_spread_points,
        max_quote_age_sec=max_quote_age_sec,
    )
    if not fresh.get("ok"):
        return fresh
    repriced_vol = min(initial_vol, float(fresh["candidateVolume"]))
    fresh["candidateVolume"] = repriced_vol
    fresh["repricedFromVolume"] = initial_vol
    fresh["volumeReducedOnReprice"] = repriced_vol < initial_vol
    fresh["executionEnabled"] = False
    return fresh
