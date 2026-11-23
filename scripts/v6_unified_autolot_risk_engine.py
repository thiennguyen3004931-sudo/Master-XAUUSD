#!/usr/bin/env python3
"""Offline-only V6 lot/risk evaluator — NOT wired to MT5 pre-send (Issue #76).

No boolean supplied to this module is evidence of broker authenticity, policy
approval or runtime LIVE authorization. Fail closed on missing broker pricing.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = 1
VALID_LOT_MODES = {"FIXED_LOT", "AUTO_LOT", "SHADOW"}
VALID_DIRECTIONS = {"BUY", "SELL"}
VALID_ACCOUNT_MODES = {"HEDGING", "NETTING"}
EPS = 1e-9


def _is_finite_pos(val: Any) -> bool:
    return not isinstance(val, bool) and isinstance(val, (int, float)) and math.isfinite(float(val)) and float(val) > 0.0


def _is_finite_nonneg(val: Any) -> bool:
    return not isinstance(val, bool) and isinstance(val, (int, float)) and math.isfinite(float(val)) and float(val) >= 0.0


def _floor_to_step(value: float, step: float) -> float:
    if step <= 0.0 or value <= 0.0:
        return 0.0
    steps = math.floor((value / step) + 1e-12)
    return round(steps * step, 8)


def _report_sha256(payload: Mapping[str, Any]) -> str:
    body = {k: v for k, v in payload.items() if k != "reportSha256"}
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def evaluate_unified_autolot_and_risk(
    *,
    requested_mode: str,
    auto_lot_owner_approved: bool,
    fixed_lot: float,
    direction: str,
    entry_price: float,
    stop_loss_price: float,
    account: Mapping[str, Any],
    broker_spec: Mapping[str, Any],
    risk_policy: Mapping[str, Any],
    open_positions: Sequence[Mapping[str, Any]] = (),
    pending_orders: Sequence[Mapping[str, Any]] = (),
    now_utc: int = 0,
    is_dca_entry: bool = False,
) -> dict[str, Any]:
    """Compute effective lot and enforce all C1/C2/C3 hard risk blocks fail-closed."""
    hard_blocks: list[str] = []
    warnings: list[str] = []

    mode = str(requested_mode or "").strip().upper()
    side = str(direction or "").strip().upper()
    if mode not in VALID_LOT_MODES:
        hard_blocks.append("INVALID_LOT_MODE")
    if side not in VALID_DIRECTIONS:
        hard_blocks.append("INVALID_DIRECTION")

    effective_mode = mode
    if mode == "AUTO_LOT" and not bool(auto_lot_owner_approved):
        hard_blocks.append("AUTO_LOT_REQUIRES_EXPLICIT_OWNER_APPROVAL")

    equity = account.get("equity")
    free_margin = account.get("freeMargin")
    daily_pnl_usd = account.get("dailyRealizedAndUnrealizedPnlUsd")
    acct_margin_mode = str(account.get("marginMode") or "").strip().upper()
    if not _is_finite_pos(equity):
        hard_blocks.append("ACCOUNT_EQUITY_MISSING_OR_INVALID")
    if not _is_finite_nonneg(free_margin):
        hard_blocks.append("ACCOUNT_FREE_MARGIN_MISSING_OR_INVALID")
    if isinstance(daily_pnl_usd, bool) or not isinstance(daily_pnl_usd, (int, float)) or not math.isfinite(float(daily_pnl_usd)):
        hard_blocks.append("DAILY_PNL_UNVERIFIED")
    if acct_margin_mode not in VALID_ACCOUNT_MODES:
        hard_blocks.append("ACCOUNT_MARGIN_MODE_UNVERIFIED")

    bid = broker_spec.get("bid")
    ask = broker_spec.get("ask")
    quote_ts = broker_spec.get("quoteTimestampUtc")
    max_quote_age = broker_spec.get("maxQuoteAgeSeconds", 15)
    contract_size = broker_spec.get("contractSize")
    vol_min = broker_spec.get("volumeMin")
    vol_max = broker_spec.get("volumeMax")
    vol_step = broker_spec.get("volumeStep")
    loss_per_lot_at_sl = broker_spec.get("orderCalcLossPerOneLotUsd")
    margin_per_one_lot = broker_spec.get("marginRequiredPerOneLotUsd")
    commission_per_lot = broker_spec.get("commissionPerLotUsd")
    slippage_usd_per_oz = broker_spec.get("estimatedSlippageUsdPerOz")
    trading_session_open = broker_spec.get("tradingSessionOpen") is True

    if not trading_session_open:
        hard_blocks.append("TRADING_SESSION_CLOSED")
    if not _is_finite_pos(bid) or not _is_finite_pos(ask) or float(ask) < float(bid):
        hard_blocks.append("INVALID_BID_ASK_QUOTE")
    if type(quote_ts) is not int or type(now_utc) is not int or not _is_finite_pos(max_quote_age):
        hard_blocks.append("QUOTE_TIMESTAMP_UNVERIFIED")
    elif (now_utc - quote_ts) < 0 or (now_utc - quote_ts) > float(max_quote_age):
        hard_blocks.append("QUOTE_STALE_FAIL_CLOSED")

    for name, val in (
        ("CONTRACT_SIZE_INVALID", contract_size),
        ("VOLUME_MIN_INVALID", vol_min),
        ("VOLUME_MAX_INVALID", vol_max),
        ("VOLUME_STEP_INVALID", vol_step),
        ("MARGIN_PER_LOT_INVALID", margin_per_one_lot),
        ("BROKER_ORDER_CALC_PROFIT_LOSS_UNVERIFIED", loss_per_lot_at_sl),
    ):
        if not _is_finite_pos(val):
            hard_blocks.append(name)

    if _is_finite_pos(vol_min) and _is_finite_pos(vol_max) and float(vol_min) > float(vol_max) + EPS:
        hard_blocks.append("BROKER_VOLUME_RANGE_INVERTED")
    if not _is_finite_pos(entry_price) or not _is_finite_pos(stop_loss_price):
        hard_blocks.append("ENTRY_OR_SL_PRICE_INVALID")
    elif side == "BUY" and float(stop_loss_price) >= float(entry_price):
        hard_blocks.append("BUY_SL_MUST_BE_BELOW_ENTRY")
    elif side == "SELL" and float(stop_loss_price) <= float(entry_price):
        hard_blocks.append("SELL_SL_MUST_BE_ABOVE_ENTRY")

    if not _is_finite_nonneg(commission_per_lot) or not _is_finite_nonneg(slippage_usd_per_oz):
        hard_blocks.append("COST_MODEL_INVALID")

    max_risk_per_trade_pct = risk_policy.get("maxRiskPerTradePct")
    max_total_risk_pct = risk_policy.get("maxTotalAccountRiskPct")
    max_daily_loss_pct = risk_policy.get("maxDailyLossPct")
    max_open_positions = risk_policy.get("maxOpenPositions")
    max_dca_layers = risk_policy.get("maxDcaLayers")
    max_lot_cap = risk_policy.get("maxLotPerOrder")
    min_free_margin_buffer_ratio = risk_policy.get("minFreeMarginBufferRatio", 1.2)

    if not _is_finite_pos(max_risk_per_trade_pct) or not _is_finite_pos(max_total_risk_pct) or not _is_finite_pos(max_daily_loss_pct):
        hard_blocks.append("RISK_POLICY_PCT_INVALID")
    if type(max_open_positions) is not int or max_open_positions <= 0:
        hard_blocks.append("MAX_OPEN_POSITIONS_INVALID")
    if type(max_dca_layers) is not int or max_dca_layers < 0:
        hard_blocks.append("MAX_DCA_LAYERS_INVALID")
    if not _is_finite_pos(max_lot_cap) or not _is_finite_pos(min_free_margin_buffer_ratio):
        hard_blocks.append("LOT_OR_MARGIN_POLICY_INVALID")

    open_count = len(open_positions)
    pending_count = len(pending_orders)
    dca_count = sum(1 for p in open_positions if isinstance(p, Mapping) and p.get("isDca") is True)
    dca_count += sum(1 for o in pending_orders if isinstance(o, Mapping) and o.get("isDca") is True)

    existing_risk_usd = 0.0
    for item in list(open_positions) + list(pending_orders):
        if not isinstance(item, Mapping) or not _is_finite_nonneg(item.get("riskUsd")):
            hard_blocks.append("EXISTING_EXPOSURE_RISK_UNVERIFIED")
            break
        existing_risk_usd += float(item["riskUsd"])

    if not hard_blocks:
        eq = float(equity)
        fm = float(free_margin)
        daily_pnl = float(daily_pnl_usd)
        max_daily_loss_usd = eq * (float(max_daily_loss_pct) / 100.0)
        if daily_pnl <= -max_daily_loss_usd + EPS:
            hard_blocks.append("HARD_DAILY_LOSS_LIMIT_REACHED")

        if (open_count + pending_count) >= max_open_positions:
            hard_blocks.append("MAX_POSITIONS_LIMIT_REACHED")
        if is_dca_entry and dca_count >= max_dca_layers:
            hard_blocks.append("MAX_DCA_LAYERS_LIMIT_REACHED")
        if acct_margin_mode == "NETTING" and open_count > 0 and is_dca_entry:
            warnings.append("NETTING_ACCOUNT_COMBINES_DCA_INTO_SINGLE_POSITION")

    computed_lot = 0.0
    effective_lot = 0.0
    estimated_order_risk_usd = 0.0
    required_margin_usd = 0.0
    risk_budget_usd = 0.0
    remaining_total_risk_usd = 0.0

    if not hard_blocks:
        eq = float(equity)
        fm = float(free_margin)
        spread_usd_per_oz = float(ask) - float(bid)
        sl_dist_usd_per_oz = abs(float(entry_price) - float(stop_loss_price))
        cs = float(contract_size)

        # An approximate distance * contractSize fallback can severely
        # understate broker-specific loss. Require verified broker loss input.
        base_loss_per_lot = float(loss_per_lot_at_sl)

        friction_per_lot = (spread_usd_per_oz + float(slippage_usd_per_oz)) * cs + float(commission_per_lot)
        total_risk_per_lot = base_loss_per_lot + friction_per_lot

        risk_budget_usd = eq * (float(max_risk_per_trade_pct) / 100.0)
        total_account_budget_usd = eq * (float(max_total_risk_pct) / 100.0)
        remaining_total_risk_usd = max(0.0, total_account_budget_usd - existing_risk_usd)
        effective_budget_usd = min(risk_budget_usd, remaining_total_risk_usd)

        if effective_budget_usd <= EPS:
            hard_blocks.append("TOTAL_ACCOUNT_RISK_BUDGET_EXHAUSTED")
        elif total_risk_per_lot <= EPS:
            hard_blocks.append("RISK_PER_LOT_INVALID")
        else:
            raw_auto_lot = effective_budget_usd / total_risk_per_lot
            floored_auto_lot = _floor_to_step(raw_auto_lot, float(vol_step))
            capped_auto_lot = min(floored_auto_lot, float(vol_max), float(max_lot_cap))
            capped_auto_lot = _floor_to_step(capped_auto_lot, float(vol_step))
            computed_lot = capped_auto_lot

            if mode == "FIXED_LOT":
                if not _is_finite_pos(fixed_lot):
                    hard_blocks.append("FIXED_LOT_INVALID")
                else:
                    candidate_lot = _floor_to_step(float(fixed_lot), float(vol_step))
                    if candidate_lot < float(vol_min) - EPS or candidate_lot > min(float(vol_max), float(max_lot_cap)) + EPS:
                        hard_blocks.append("FIXED_LOT_OUT_OF_BOUNDS")
                    else:
                        effective_lot = candidate_lot
            elif mode == "AUTO_LOT":
                if computed_lot < float(vol_min) - EPS:
                    hard_blocks.append("AUTO_LOT_BELOW_VOLUME_MIN_EXCEEDS_RISK_BUDGET")
                else:
                    effective_lot = computed_lot
            elif mode == "SHADOW":
                if not _is_finite_pos(fixed_lot):
                    hard_blocks.append("SHADOW_FALLBACK_FIXED_LOT_INVALID")
                else:
                    effective_lot = _floor_to_step(float(fixed_lot), float(vol_step))
                if computed_lot < float(vol_min) - EPS:
                    warnings.append("SHADOW_AUTO_LOT_WOULD_BLOCK_BELOW_VOLUME_MIN")

            if not hard_blocks and effective_lot > 0.0:
                estimated_order_risk_usd = round(effective_lot * total_risk_per_lot, 4)
                if estimated_order_risk_usd > effective_budget_usd + 1e-6:
                    hard_blocks.append("ORDER_RISK_EXCEEDS_BUDGET")
                required_margin_usd = round(effective_lot * float(margin_per_one_lot), 4)
                if fm < required_margin_usd * float(min_free_margin_buffer_ratio) - EPS:
                    hard_blocks.append("INSUFFICIENT_FREE_MARGIN")

    allowed = len(hard_blocks) == 0 and effective_lot > 0.0
    result: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "requestedMode": mode,
        "effectiveLotMode": effective_mode,
        "autoLotOwnerApproved": bool(auto_lot_owner_approved),
        "direction": side,
        "accountMarginMode": acct_margin_mode,
        "computedAutoLot": round(computed_lot, 8),
        "effectiveLot": round(effective_lot if allowed else 0.0, 8),
        "riskBudgetUsd": round(risk_budget_usd, 4),
        "remainingTotalRiskUsd": round(remaining_total_risk_usd, 4),
        "estimatedOrderRiskUsd": estimated_order_risk_usd,
        "requiredMarginUsd": required_margin_usd,
        "allowed": allowed,
        "evaluationScope": "OFFLINE_ONLY_NOT_WIRED_TO_FINAL_MT5_ORDER_SEND",
        "runtimePreSendIntegrated": False,
        "brokerPricingProvenanceVerified": False,
        "hardBlocks": sorted(set(hard_blocks)),
        "warnings": sorted(set(warnings)),
        "liveAuthorized": False,
    }
    result["reportSha256"] = _report_sha256(result)
    return result
