#!/usr/bin/env python3
"""V6 Trading Entry, Structural M5 SL, Break-Even & Trailing Stop Engine (Stream D — #7)."""

from __future__ import annotations

import math
from typing import Any, Mapping


EPS = 1e-9
DEFAULT_SL_MIN_USD = 6.0
DEFAULT_SL_MAX_USD = 8.0
DEFAULT_M15_FAST_MOVE_TRAIL_USD = 10.0


def _is_pos(val: Any) -> bool:
    return not isinstance(val, bool) and isinstance(val, (int, float)) and math.isfinite(float(val)) and float(val) > 0.0


def _is_nonneg(val: Any) -> bool:
    return not isinstance(val, bool) and isinstance(val, (int, float)) and math.isfinite(float(val)) and float(val) >= 0.0


def evaluate_entry_and_initial_sl(
    *,
    regime: str,
    buy_signal: bool,
    sell_signal: bool,
    candle_closed: bool,
    entry_price: float,
    m5_structural_sl: float,
    take_profit: float,
    nearby_obstacle_distance_usd: float,
    min_obstacle_clearance_usd: float = 4.0,
    min_sl_usd: float = DEFAULT_SL_MIN_USD,
    max_sl_usd: float = DEFAULT_SL_MAX_USD,
    min_rr_ratio: float = 1.2,
    broker_stops_level_usd: float = 0.5,
) -> dict[str, Any]:
    """Evaluate D1 entry filter + D2 M5 structural SL (6-8 USD/oz) + D4 TP sanity."""
    reg = str(regime or "").strip().upper()
    if reg not in {"TREND", "SIDEWAY"}:
        return {"action": "SKIP", "reason": "REGIME_NO_TRADE", "liveAuthorized": False}
    if not candle_closed:
        return {"action": "SKIP", "reason": "UNCLOSED_CANDLE_REJECTED", "liveAuthorized": False}
    if buy_signal and sell_signal:
        return {"action": "SKIP", "reason": "CONFLICTING_BUY_SELL_SIGNAL", "liveAuthorized": False}
    if not buy_signal and not sell_signal:
        return {"action": "SKIP", "reason": "NO_ACTIVE_SIGNAL", "liveAuthorized": False}

    direction = "BUY" if buy_signal else "SELL"
    if not (_is_pos(entry_price) and _is_pos(m5_structural_sl) and _is_pos(take_profit)):
        return {"action": "SKIP", "reason": "INVALID_PRICE_INPUTS", "liveAuthorized": False}
    if (
        not _is_nonneg(min_obstacle_clearance_usd)
        or not _is_pos(min_sl_usd)
        or not _is_pos(max_sl_usd)
        or float(max_sl_usd) < float(min_sl_usd)
        or not _is_pos(min_rr_ratio)
        or not _is_nonneg(broker_stops_level_usd)
    ):
        return {"action": "SKIP", "reason": "INVALID_STRATEGY_OR_BROKER_POLICY", "liveAuthorized": False}
    if not _is_nonneg(nearby_obstacle_distance_usd) or float(nearby_obstacle_distance_usd) < float(min_obstacle_clearance_usd) - EPS:
        return {"action": "SKIP", "reason": "NEARBY_OBSTACLE_TOO_CLOSE", "liveAuthorized": False}

    entry = float(entry_price)
    sl = float(m5_structural_sl)
    tp = float(take_profit)
    stops_lvl = float(broker_stops_level_usd)

    if direction == "BUY":
        sl_dist = entry - sl
        tp_dist = tp - entry
    else:
        sl_dist = sl - entry
        tp_dist = entry - tp

    if sl_dist <= EPS or tp_dist <= EPS:
        return {"action": "SKIP", "reason": "INVALID_SL_OR_TP_SIDE", "liveAuthorized": False}
    if sl_dist < stops_lvl - EPS or tp_dist < stops_lvl - EPS:
        return {"action": "SKIP", "reason": "VIOLATES_BROKER_STOPS_LEVEL", "liveAuthorized": False}
    if sl_dist > float(max_sl_usd) + EPS:
        return {
            "action": "WAIT_PULLBACK_OR_SKIP",
            "reason": "STRUCTURAL_SL_TOO_WIDE_DO_NOT_TIGHTEN",
            "structuralSlDistanceUsd": round(sl_dist, 4),
            "liveAuthorized": False,
        }
    if sl_dist < float(min_sl_usd) - EPS:
        return {
            "action": "SKIP",
            "reason": "STRUCTURAL_SL_TOO_TIGHT_BELOW_MIN_BAND",
            "structuralSlDistanceUsd": round(sl_dist, 4),
            "liveAuthorized": False,
        }

    rr = tp_dist / sl_dist
    if rr < float(min_rr_ratio) - EPS:
        return {
            "action": "SKIP",
            "reason": "RR_RATIO_BELOW_MINIMUM",
            "rrRatio": round(rr, 4),
            "liveAuthorized": False,
        }

    return {
        "action": "ADMIT_OFFLINE_CANDIDATE",
        "direction": direction,
        "entryPrice": round(entry, 4),
        "initialSl": round(sl, 4),
        "takeProfit": round(tp, 4),
        "slDistanceUsd": round(sl_dist, 4),
        "rrRatio": round(rr, 4),
        "reason": "D1_D2_D4_CANDIDATE_VALID",
        "liveAuthorized": False,
    }


def compute_next_protective_sl(
    *,
    position: Mapping[str, Any],
    bot_magic: int,
    current_bid: float,
    current_ask: float,
    m5_new_structure_sl: float | None = None,
    m15_fast_move_active: bool = False,
    favorable_extreme_price: float | None = None,
    be_trigger_usd: float | None = None,
    be_offset_usd: float = 0.2,
    m15_fast_trail_distance_usd: float = DEFAULT_M15_FAST_MOVE_TRAIL_USD,
    broker_stops_level_usd: float = 0.5,
    broker_freeze_level_usd: float = 0.3,
) -> dict[str, Any]:
    """Offline monotonic SL proposal: BE at >=1R initial risk; no live order."""
    pos_magic = position.get("magic")
    if type(pos_magic) is not int or pos_magic != bot_magic:
        return {
            "shouldModify": False,
            "reason": "POSITION_NOT_OWNED_BY_BOT",
            "nextSl": position.get("currentSl"),
            "liveAuthorized": False,
        }

    direction = str(position.get("direction") or "").strip().upper()
    entry = position.get("entryPrice")
    current_sl = position.get("currentSl")
    if direction not in {"BUY", "SELL"} or not _is_pos(entry) or not _is_pos(current_sl):
        return {
            "shouldModify": False,
            "reason": "INVALID_POSITION_STATE",
            "nextSl": current_sl,
            "liveAuthorized": False,
        }
    if not _is_pos(current_bid) or not _is_pos(current_ask) or float(current_ask) < float(current_bid):
        return {
            "shouldModify": False,
            "reason": "INVALID_MARKET_QUOTE",
            "nextSl": float(current_sl),
            "liveAuthorized": False,
        }

    entry_f = float(entry)
    cur_sl_f = float(current_sl)
    bid_f = float(current_bid)
    ask_f = float(current_ask)
    # Unknown/invalid broker constraints must never result in a suggested SL.
    if (
        not _is_nonneg(broker_stops_level_usd)
        or not _is_nonneg(broker_freeze_level_usd)
        or not _is_nonneg(be_offset_usd)
        or not _is_pos(m15_fast_trail_distance_usd)
        or (be_trigger_usd is not None and not _is_pos(be_trigger_usd))
    ):
        return {
            "shouldModify": False,
            "reason": "BROKER_OR_TRAILING_POLICY_UNVERIFIED",
            "nextSl": round(cur_sl_f, 4),
            "liveAuthorized": False,
        }
    stops_lvl = float(broker_stops_level_usd)
    freeze_lvl = float(broker_freeze_level_usd)

    market_ref = bid_f if direction == "BUY" else ask_f
    if abs(market_ref - cur_sl_f) <= freeze_lvl + EPS:
        return {
            "shouldModify": False,
            "reason": "BLOCKED_BY_BROKER_FREEZE_LEVEL",
            "nextSl": round(cur_sl_f, 4),
            "liveAuthorized": False,
        }

    candidates: list[tuple[float, str]] = []

    profit_usd = (bid_f - entry_f) if direction == "BUY" else (entry_f - ask_f)
    # Break-even is triggered by 1R of the ORIGINAL stop distance, not a
    # hard-coded 6 USD price move. Trailing can still raise protection when
    # original risk evidence is absent, but BE must remain unverified.
    initial_risk = position.get("initialRiskUsd")
    if not _is_pos(initial_risk):
        initial_sl = position.get("initialSl")
        if _is_pos(initial_sl):
            structural_risk = (
                entry_f - float(initial_sl)
                if direction == "BUY" else float(initial_sl) - entry_f
            )
            initial_risk = structural_risk if structural_risk > EPS else None
        else:
            initial_risk = None
    if _is_pos(initial_risk):
        initial_r = float(initial_risk)
    else:
        initial_r = None
    # Explicit override may only INCREASE the required 1R trigger.
    trigger = (
        max(initial_r, float(be_trigger_usd))
        if initial_r is not None and be_trigger_usd is not None
        else initial_r
    )
    if trigger is not None and profit_usd >= trigger - EPS:
        be_sl = (entry_f + float(be_offset_usd)) if direction == "BUY" else (entry_f - float(be_offset_usd))
        candidates.append((be_sl, "BREAK_EVEN"))

    if _is_pos(m5_new_structure_sl):
        candidates.append((float(m5_new_structure_sl), "M5_STRUCTURAL_TRAIL"))

    if m15_fast_move_active and _is_pos(favorable_extreme_price):
        ext = float(favorable_extreme_price)
        fast_sl = (ext - float(m15_fast_trail_distance_usd)) if direction == "BUY" else (ext + float(m15_fast_trail_distance_usd))
        candidates.append((fast_sl, "M15_FAST_MOVE_10USD_TRAIL"))

    best_sl = cur_sl_f
    best_reason = "HOLD_EXISTING_SL"

    for cand_sl, reason in candidates:
        if direction == "BUY":
            if cand_sl <= best_sl + EPS:
                continue
            if (bid_f - cand_sl) < stops_lvl - EPS:
                continue
            best_sl = cand_sl
            best_reason = reason
        else:
            if cand_sl >= best_sl - EPS:
                continue
            if (cand_sl - ask_f) < stops_lvl - EPS:
                continue
            best_sl = cand_sl
            best_reason = reason

    changed = abs(best_sl - cur_sl_f) > EPS
    return {
        "shouldModify": changed,
        "evaluationScope": "OFFLINE_PROTECTIVE_SL_PROPOSAL_NO_MT5_ORDER",
        "initialRiskUsd": initial_r,
        "direction": direction,
        "previousSl": round(cur_sl_f, 4),
        "nextSl": round(best_sl, 4),
        "reason": best_reason,
        "liveAuthorized": False,
    }
