#!/usr/bin/env python3
"""V6 Auto Lot Broker-Snapshot & Same-Tick Final Pre-Send Hard Gate (Stream C — Issue #76)."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = 1
VALID_MODES = {"FIXED_LOT", "AUTO_LOT", "SHADOW"}
VALID_SIDES = {"BUY", "SELL"}
EPS = 1e-9


def _is_pos(val: Any) -> bool:
    return not isinstance(val, bool) and isinstance(val, (int, float)) and math.isfinite(float(val)) and float(val) > 0.0


def _is_nonneg(val: Any) -> bool:
    return not isinstance(val, bool) and isinstance(val, (int, float)) and math.isfinite(float(val)) and float(val) >= 0.0


def _sha256_canonical(payload: Mapping[str, Any]) -> str:
    body = {k: v for k, v in payload.items() if k != "reportSha256"}
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _floor_lot_on_broker_grid(raw_lot: float, vol_min: float, vol_step: float, vol_max: float) -> float:
    if raw_lot < vol_min - EPS or vol_step <= 0.0:
        return 0.0
    n = math.floor(((raw_lot - vol_min) / vol_step) + 1e-12)
    if n < 0:
        return 0.0
    grid_lot = round(vol_min + n * vol_step, 8)
    if grid_lot > vol_max + EPS:
        n_max = math.floor(((vol_max - vol_min) / vol_step) + 1e-12)
        grid_lot = round(vol_min + max(0, n_max) * vol_step, 8)
    return grid_lot


def evaluate_same_tick_presend_autolot_gate(
    *,
    requested_mode: str,
    auto_lot_owner_approved: Any,
    fixed_lot: float,
    side: str,
    entry_price: float,
    stop_loss_price: float,
    broker_snapshot: Mapping[str, Any],
    risk_policy: Mapping[str, Any],
    open_positions: Sequence[Mapping[str, Any]] = (),
    pending_orders: Sequence[Mapping[str, Any]] = (),
    now_utc: int,
    emergency_stop_active: bool = True,
) -> dict[str, Any]:
    """Same-tick final pre-send hard gate combining Emergency Stop, Auto Lot, and daily-loss stop."""
    blocks: list[str] = []

    if emergency_stop_active is not False:
        blocks.append("EMERGENCY_STOP_ACTIVE_FAIL_CLOSED")

    mode = str(requested_mode or "").strip().upper()
    direction = str(side or "").strip().upper()
    if mode not in VALID_MODES:
        blocks.append("INVALID_LOT_MODE")
    if direction not in VALID_SIDES:
        blocks.append("INVALID_DIRECTION")
    if mode == "AUTO_LOT" and auto_lot_owner_approved is not True:
        blocks.append("AUTO_LOT_OWNER_APPROVAL_REQUIRED")

    acct_login = broker_snapshot.get("accountLogin")
    acct_currency = str(broker_snapshot.get("accountCurrency") or "").strip().upper()
    equity = broker_snapshot.get("equity")
    free_margin = broker_snapshot.get("freeMargin")
    daily_pnl = broker_snapshot.get("dailyRealizedAndUnrealizedPnlUsd")
    bid = broker_snapshot.get("bid")
    ask = broker_snapshot.get("ask")
    quote_ts = broker_snapshot.get("quoteTimestampUtc")
    max_quote_age = broker_snapshot.get("maxQuoteAgeSeconds", 5)
    vol_min = broker_snapshot.get("volumeMin")
    vol_max = broker_snapshot.get("volumeMax")
    vol_step = broker_snapshot.get("volumeStep")
    calc_profit_loss_1lot = broker_snapshot.get("orderCalcProfitLossOneLotUsd")
    calc_margin_1lot = broker_snapshot.get("orderCalcMarginOneLotUsd")
    commission_per_lot = broker_snapshot.get("commissionPerLotUsd", 0.0)
    contract_size = broker_snapshot.get("contractSize")
    slippage_usd_per_oz = broker_snapshot.get("estimatedSlippageUsdPerOz", 0.0)
    session_open = broker_snapshot.get("tradingSessionOpen") is True

    if type(acct_login) is not int or acct_login <= 0:
        blocks.append("ACCOUNT_LOGIN_UNVERIFIED")
    if acct_currency != "USD":
        blocks.append("UNVERIFIED_OR_NON_USD_ACCOUNT_CURRENCY")
    if not _is_pos(equity) or not _is_nonneg(free_margin):
        blocks.append("ACCOUNT_EQUITY_OR_MARGIN_INVALID")
    if isinstance(daily_pnl, bool) or not isinstance(daily_pnl, (int, float)) or not math.isfinite(float(daily_pnl)):
        blocks.append("DAILY_PNL_UNVERIFIED")
    if not session_open:
        blocks.append("TRADING_SESSION_CLOSED")
    if not _is_pos(bid) or not _is_pos(ask) or float(ask) < float(bid):
        blocks.append("INVALID_BID_ASK_QUOTE")
    if type(quote_ts) is not int or type(now_utc) is not int or type(max_quote_age) is not int or max_quote_age <= 0:
        blocks.append("QUOTE_TIMESTAMP_INVALID")
    elif (now_utc - quote_ts) < 0 or (now_utc - quote_ts) > max_quote_age:
        blocks.append("SAME_TICK_QUOTE_STALE")

    if not _is_pos(calc_profit_loss_1lot):
        blocks.append("ORDER_CALC_PROFIT_UNVERIFIED")
    if not _is_pos(calc_margin_1lot):
        blocks.append("ORDER_CALC_MARGIN_UNVERIFIED")
    if not _is_pos(vol_min) or not _is_pos(vol_max) or not _is_pos(vol_step) or not _is_pos(contract_size):
        blocks.append("BROKER_SYMBOL_SPEC_INVALID")
    if not _is_nonneg(commission_per_lot) or not _is_nonneg(slippage_usd_per_oz):
        blocks.append("BROKER_COST_SPEC_INVALID")

    if not _is_pos(entry_price) or not _is_pos(stop_loss_price):
        blocks.append("INVALID_ENTRY_OR_SL")
    elif direction == "BUY" and float(stop_loss_price) >= float(entry_price):
        blocks.append("BUY_SL_MUST_BE_BELOW_ENTRY")
    elif direction == "SELL" and float(stop_loss_price) <= float(entry_price):
        blocks.append("SELL_SL_MUST_BE_ABOVE_ENTRY")

    max_risk_pct = risk_policy.get("maxRiskPerTradePct")
    max_total_pct = risk_policy.get("maxTotalAccountRiskPct")
    max_daily_loss_pct = risk_policy.get("maxDailyLossPct")
    max_open_pos = risk_policy.get("maxOpenPositions")
    max_lot_cap = risk_policy.get("maxLotPerOrder")
    margin_buf = risk_policy.get("minFreeMarginBufferRatio", 1.2)
    if (
        not _is_pos(max_risk_pct)
        or not _is_pos(max_total_pct)
        or not _is_pos(max_daily_loss_pct)
        or type(max_open_pos) is not int
        or max_open_pos <= 0
        or not _is_pos(max_lot_cap)
        or not _is_pos(margin_buf)
    ):
        blocks.append("RISK_POLICY_INVALID")

    existing_risk = 0.0
    for item in list(open_positions) + list(pending_orders):
        if not isinstance(item, Mapping) or not _is_nonneg(item.get("riskUsd")):
            blocks.append("OPEN_OR_PENDING_EXPOSURE_UNVERIFIED")
            break
        existing_risk += float(item["riskUsd"])

    computed_lot = 0.0
    effective_lot = 0.0
    order_risk_usd = 0.0
    required_margin_usd = 0.0

    if not any(
        b in blocks
        for b in (
            "ACCOUNT_EQUITY_OR_MARGIN_INVALID",
            "DAILY_PNL_UNVERIFIED",
            "ORDER_CALC_PROFIT_UNVERIFIED",
            "ORDER_CALC_MARGIN_UNVERIFIED",
            "BROKER_SYMBOL_SPEC_INVALID",
            "BROKER_COST_SPEC_INVALID",
            "INVALID_BID_ASK_QUOTE",
            "RISK_POLICY_INVALID",
            "OPEN_OR_PENDING_EXPOSURE_UNVERIFIED",
        )
    ):
        eq = float(equity)
        fm = float(free_margin)
        max_daily_loss_usd = eq * (float(max_daily_loss_pct) / 100.0)
        if float(daily_pnl) <= -max_daily_loss_usd + EPS:
            blocks.append("HARD_DAILY_LOSS_STOP_ACTIVE")

        if (len(open_positions) + len(pending_orders)) >= max_open_pos:
            blocks.append("MAX_POSITIONS_EXCEEDED")

        per_trade_budget = eq * (float(max_risk_pct) / 100.0)
        total_budget = eq * (float(max_total_pct) / 100.0)
        remaining_budget = max(0.0, total_budget - existing_risk)
        eff_budget = min(per_trade_budget, remaining_budget)

        spread_usd = float(ask) - float(bid)
        friction_1lot = (spread_usd + float(slippage_usd_per_oz)) * float(contract_size) + float(commission_per_lot)
        total_loss_1lot = float(calc_profit_loss_1lot) + friction_1lot

        if eff_budget <= EPS:
            blocks.append("TOTAL_RISK_BUDGET_EXHAUSTED")
        elif total_loss_1lot <= EPS:
            blocks.append("ORDER_LOSS_PER_LOT_INVALID")
        else:
            raw_lot = eff_budget / total_loss_1lot
            computed_lot = _floor_lot_on_broker_grid(
                raw_lot,
                float(vol_min),
                float(vol_step),
                min(float(vol_max), float(max_lot_cap)),
            )
            if mode == "FIXED_LOT":
                if not _is_pos(fixed_lot):
                    blocks.append("FIXED_LOT_INVALID")
                else:
                    effective_lot = _floor_lot_on_broker_grid(
                        float(fixed_lot), float(vol_min), float(vol_step), min(float(vol_max), float(max_lot_cap))
                    )
                    if effective_lot < float(vol_min) - EPS:
                        blocks.append("FIXED_LOT_OUT_OF_GRID")
            elif mode == "AUTO_LOT":
                if computed_lot < float(vol_min) - EPS:
                    blocks.append("AUTO_LOT_BELOW_VOLUME_MIN_RISK_GUARD")
                else:
                    effective_lot = computed_lot
            elif mode == "SHADOW":
                if not _is_pos(fixed_lot):
                    blocks.append("SHADOW_FIXED_LOT_INVALID")
                else:
                    effective_lot = _floor_lot_on_broker_grid(
                        float(fixed_lot), float(vol_min), float(vol_step), min(float(vol_max), float(max_lot_cap))
                    )

            if effective_lot > 0.0:
                order_risk_usd = round(effective_lot * total_loss_1lot, 4)
                required_margin_usd = round(effective_lot * float(calc_margin_1lot), 4)
                if order_risk_usd > eff_budget + 1e-6:
                    blocks.append("ORDER_RISK_EXCEEDS_BUDGET")
                if fm < required_margin_usd * float(margin_buf) - EPS:
                    blocks.append("INSUFFICIENT_FREE_MARGIN")

    admitted = len(blocks) == 0 and effective_lot > 0.0
    rep: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "scope": "OFFLINE_SAME_TICK_PRESEND_AUTOLOT_GATE_NO_ORDER",
        "requestedMode": mode,
        "direction": direction,
        "computedAutoLot": round(computed_lot, 8),
        "effectiveLot": round(effective_lot if admitted else 0.0, 8),
        "estimatedOrderRiskUsd": order_risk_usd,
        "requiredMarginUsd": required_margin_usd,
        "admitted": admitted,
        "hardBlocks": sorted(set(blocks)),
        "liveAuthorized": False,
    }
    rep["reportSha256"] = _sha256_canonical(rep)
    return rep
