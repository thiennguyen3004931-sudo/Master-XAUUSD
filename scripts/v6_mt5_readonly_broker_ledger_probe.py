#!/usr/bin/env python3
"""Read-only MT5 Broker-Owned Pricing, Inventory, Netting & Daily P&L Ledger Probe (Issue #76)."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = 1
SCOPE = "READONLY_MT5_BROKER_PRICING_INVENTORY_AND_DAILY_PNL_NO_ORDER"
DEFAULT_SL_PROBE_DISTANCE_USD = 7.0


def _is_finite_num(val: Any) -> bool:
    return not isinstance(val, bool) and isinstance(val, (int, float)) and math.isfinite(float(val))


def _sha256_canonical(payload: Mapping[str, Any]) -> str:
    body = {k: v for k, v in payload.items() if k != "reportSha256"}
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _mask_login(login: Any) -> str:
    s = str(login or "").strip()
    if len(s) <= 3:
        return "***"
    return "***" + s[-3:]


def _margin_mode_label(raw_mode: Any) -> str:
    if raw_mode == 2:
        return "HEDGING"
    if raw_mode in (0, 1):
        return "NETTING"
    return "UNKNOWN"


def _trade_mode_label(raw_mode: Any) -> str:
    if raw_mode == 2:
        return "REAL"
    if raw_mode == 0:
        return "DEMO"
    if raw_mode == 1:
        return "CONTEST"
    return "UNKNOWN"


def build_broker_ledger_snapshot(
    *,
    account_info: Mapping[str, Any] | None,
    symbol_info: Mapping[str, Any] | None,
    tick_info: Mapping[str, Any] | None,
    positions: Sequence[Mapping[str, Any]] | None,
    pending_orders: Sequence[Mapping[str, Any]] | None,
    today_deals: Sequence[Mapping[str, Any]] | None,
    buy_calc_profit_1lot: float | None,
    sell_calc_profit_1lot: float | None,
    buy_calc_margin_1lot: float | None,
    sell_calc_margin_1lot: float | None,
    now_utc: int,
    max_quote_age_seconds: int = 15,
) -> dict[str, Any]:
    """Assemble a fail-closed broker-owned ledger snapshot from read-only MT5 payloads."""
    missing: list[str] = []
    if not isinstance(account_info, Mapping):
        missing.append("ACCOUNT_INFO_MISSING")
    if not isinstance(symbol_info, Mapping):
        missing.append("SYMBOL_INFO_MISSING")
    if not isinstance(tick_info, Mapping):
        missing.append("TICK_INFO_MISSING")
    if positions is None:
        missing.append("POSITIONS_INVENTORY_UNAVAILABLE")
    if pending_orders is None:
        missing.append("PENDING_ORDERS_INVENTORY_UNAVAILABLE")
    if today_deals is None:
        missing.append("DAILY_DEALS_HISTORY_UNAVAILABLE")

    if missing:
        rep: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "scope": SCOPE,
            "generatedAtUtc": int(now_utc),
            "status": "BROKER_READONLY_INCOMPLETE",
            "missingFields": sorted(missing),
            "brokerProvenanceVerified": False,
            "orderSendCalled": False,
            "liveAuthorized": False,
            "secretsExposed": False,
        }
        rep["reportSha256"] = _sha256_canonical(rep)
        return rep

    assert account_info is not None and symbol_info is not None and tick_info is not None
    assert positions is not None and pending_orders is not None and today_deals is not None

    bid = tick_info.get("bid")
    ask = tick_info.get("ask")
    tick_ts = tick_info.get("time")
    quote_fresh = (
        _is_finite_num(bid)
        and _is_finite_num(ask)
        and float(ask) >= float(bid) > 0.0
        and type(tick_ts) is int
        and 0 <= (int(now_utc) - tick_ts) <= int(max_quote_age_seconds)
    )

    unrealized_pnl = 0.0
    pos_count = 0
    for pos in positions:
        if not isinstance(pos, Mapping):
            continue
        p_profit = pos.get("profit", 0.0)
        p_swap = pos.get("swap", 0.0)
        if _is_finite_num(p_profit) and _is_finite_num(p_swap):
            unrealized_pnl += float(p_profit) + float(p_swap)
            pos_count += 1

    realized_pnl = 0.0
    deal_count = 0
    for deal in today_deals:
        if not isinstance(deal, Mapping):
            continue
        vals = [deal.get("profit", 0.0), deal.get("commission", 0.0), deal.get("swap", 0.0), deal.get("fee", 0.0)]
        if all(_is_finite_num(v) for v in vals):
            realized_pnl += sum(float(v) for v in vals)
            deal_count += 1

    daily_total_pnl = round(realized_pnl + unrealized_pnl, 4)

    buy_loss_1lot = abs(float(buy_calc_profit_1lot)) if _is_finite_num(buy_calc_profit_1lot) and float(buy_calc_profit_1lot) < 0.0 else None
    sell_loss_1lot = abs(float(sell_calc_profit_1lot)) if _is_finite_num(sell_calc_profit_1lot) and float(sell_calc_profit_1lot) < 0.0 else None
    buy_margin = float(buy_calc_margin_1lot) if _is_finite_num(buy_calc_margin_1lot) and float(buy_calc_margin_1lot) > 0.0 else None
    sell_margin = float(sell_calc_margin_1lot) if _is_finite_num(sell_calc_margin_1lot) and float(sell_calc_margin_1lot) > 0.0 else None

    pricing_ok = (
        buy_loss_1lot is not None
        and sell_loss_1lot is not None
        and buy_margin is not None
        and sell_margin is not None
        and quote_fresh
    )

    rep = {
        "schemaVersion": SCHEMA_VERSION,
        "scope": SCOPE,
        "generatedAtUtc": int(now_utc),
        "account": {
            "accountMasked": _mask_login(account_info.get("login")),
            "server": str(account_info.get("server") or "").strip(),
            "currency": str(account_info.get("currency") or "").strip().upper(),
            "accountMode": _trade_mode_label(account_info.get("trade_mode")),
            "marginMode": _margin_mode_label(account_info.get("margin_mode")),
            "equity": round(float(account_info["equity"]), 4) if _is_finite_num(account_info.get("equity")) else None,
            "freeMargin": round(float(account_info["margin_free"]), 4) if _is_finite_num(account_info.get("margin_free")) else None,
            "marginSoMode": account_info.get("margin_so_mode"),
            "marginSoCall": account_info.get("margin_so_call"),
            "marginSoSo": account_info.get("margin_so_so"),
        },
        "symbolSpec": {
            "symbol": str(symbol_info.get("name") or "").strip(),
            "contractSize": symbol_info.get("trade_contract_size"),
            "volumeMin": symbol_info.get("volume_min"),
            "volumeMax": symbol_info.get("volume_max"),
            "volumeStep": symbol_info.get("volume_step"),
            "stopsLevelPoints": symbol_info.get("trade_stops_level"),
            "freezeLevelPoints": symbol_info.get("trade_freeze_level"),
            "point": symbol_info.get("point"),
        },
        "quote": {
            "bid": float(bid) if _is_finite_num(bid) else None,
            "ask": float(ask) if _is_finite_num(ask) else None,
            "quoteTimestampUtc": tick_ts if type(tick_ts) is int else None,
            "quoteFresh": quote_fresh,
        },
        "brokerCalcOneLot": {
            "probeSlDistanceUsd": DEFAULT_SL_PROBE_DISTANCE_USD,
            "buyLossPerOneLotUsd": round(buy_loss_1lot, 4) if buy_loss_1lot is not None else None,
            "sellLossPerOneLotUsd": round(sell_loss_1lot, 4) if sell_loss_1lot is not None else None,
            "buyMarginPerOneLotUsd": round(buy_margin, 4) if buy_margin is not None else None,
            "sellMarginPerOneLotUsd": round(sell_margin, 4) if sell_margin is not None else None,
        },
        "inventoryAndDailyPnl": {
            "openPositionsCount": pos_count,
            "pendingOrdersCount": len(pending_orders),
            "todayClosedDealsCount": deal_count,
            "dailyRealizedPnlUsd": round(realized_pnl, 4),
            "dailyUnrealizedPnlUsd": round(unrealized_pnl, 4),
            "dailyTotalPnlUsd": daily_total_pnl,
        },
        "brokerProvenanceVerified": pricing_ok,
        "status": "BROKER_READONLY_LEDGER_VERIFIED" if pricing_ok else "BROKER_READONLY_PARTIAL_OR_STALE",
        "orderSendCalled": False,
        "liveAuthorized": False,
        "secretsExposed": False,
    }
    rep["reportSha256"] = _sha256_canonical(rep)
    return rep


def collect_live_mt5_readonly_ledger(symbol: str = "XAUUSD.G") -> dict[str, Any]:
    """Read live MT5 broker ledger in strict READ-ONLY mode (fails closed if MT5 unavailable)."""
    now_utc = int(datetime.now(timezone.utc).timestamp())
    try:
        import MetaTrader5 as mt5  # type: ignore
    except Exception:
        return build_broker_ledger_snapshot(
            account_info=None,
            symbol_info=None,
            tick_info=None,
            positions=None,
            pending_orders=None,
            today_deals=None,
            buy_calc_profit_1lot=None,
            sell_calc_profit_1lot=None,
            buy_calc_margin_1lot=None,
            sell_calc_margin_1lot=None,
            now_utc=now_utc,
        )

    if not mt5.initialize():
        return build_broker_ledger_snapshot(
            account_info=None,
            symbol_info=None,
            tick_info=None,
            positions=None,
            pending_orders=None,
            today_deals=None,
            buy_calc_profit_1lot=None,
            sell_calc_profit_1lot=None,
            buy_calc_margin_1lot=None,
            sell_calc_margin_1lot=None,
            now_utc=now_utc,
        )

    try:
        acct = mt5.account_info()
        sym = mt5.symbol_info(symbol)
        tick = mt5.symbol_info_tick(symbol)
        pos_raw = mt5.positions_get()
        ord_raw = mt5.orders_get()
        day_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        deals_raw = mt5.history_deals_get(day_start, datetime.now(timezone.utc))

        acct_d = acct._asdict() if acct is not None else None
        sym_d = sym._asdict() if sym is not None else None
        tick_d = tick._asdict() if tick is not None else None
        pos_l = [p._asdict() for p in pos_raw] if pos_raw is not None else None
        ord_l = [o._asdict() for o in ord_raw] if ord_raw is not None else None
        deals_l = [d._asdict() for d in deals_raw] if deals_raw is not None else None

        buy_p = sell_p = buy_m = sell_m = None
        if tick_d and _is_finite_num(tick_d.get("ask")) and _is_finite_num(tick_d.get("bid")):
            ask = float(tick_d["ask"])
            bid = float(tick_d["bid"])
            buy_p = mt5.order_calc_profit(mt5.ORDER_TYPE_BUY, symbol, 1.0, ask, ask - DEFAULT_SL_PROBE_DISTANCE_USD)
            sell_p = mt5.order_calc_profit(mt5.ORDER_TYPE_SELL, symbol, 1.0, bid, bid + DEFAULT_SL_PROBE_DISTANCE_USD)
            buy_m = mt5.order_calc_margin(mt5.ORDER_TYPE_BUY, symbol, 1.0, ask)
            sell_m = mt5.order_calc_margin(mt5.ORDER_TYPE_SELL, symbol, 1.0, bid)

        return build_broker_ledger_snapshot(
            account_info=acct_d,
            symbol_info=sym_d,
            tick_info=tick_d,
            positions=pos_l,
            pending_orders=ord_l,
            today_deals=deals_l,
            buy_calc_profit_1lot=buy_p,
            sell_calc_profit_1lot=sell_p,
            buy_calc_margin_1lot=buy_m,
            sell_calc_margin_1lot=sell_m,
            now_utc=now_utc,
        )
    finally:
        mt5.shutdown()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only MT5 broker pricing/inventory/daily-PnL probe.")
    parser.add_argument("--symbol", default="XAUUSD.G")
    args = parser.parse_args(argv)
    print(json.dumps(collect_live_mt5_readonly_ledger(args.symbol), indent=2, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
