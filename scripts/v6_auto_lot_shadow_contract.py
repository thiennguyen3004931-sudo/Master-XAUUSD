"""G2 P1 shadow-only Auto Lot contract: trusted clock, cost/commission/slippage, STOP_LIMIT & all-symbol exposure (#76).

Strictly SHADOW-ONLY:
- NEVER enables Auto Risk Lot for live order execution (`executionEnabled` is always `False`,
  `activeSizingMode` remains `"FIXED_LOT"`).
- Fails closed on:
  * unauthenticated or mismatched account/server,
  * unverified/assumed broker contract,
  * stale snapshot or clock skew beyond bounds,
  * missing stop-loss on any open position or pending order across ALL symbols,
  * unknown pending order types (supports BUY_LIMIT=2, SELL_LIMIT=3, BUY_STOP=4,
    SELL_STOP=5, BUY_STOP_LIMIT=6, SELL_STOP_LIMIT=7),
  * insufficient risk budget after commission, swap, and slippage buffers.
"""
from __future__ import annotations

import math
from typing import Any

PENDING_ORDER_TYPES = {
    2: "BUY_LIMIT",
    3: "SELL_LIMIT",
    4: "BUY_STOP",
    5: "SELL_STOP",
    6: "BUY_STOP_LIMIT",
    7: "SELL_STOP_LIMIT",
}

POSITION_TYPES = {
    0: "BUY",
    1: "SELL",
}


def _is_finite_pos(val: Any) -> bool:
    return isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(val) and val > 0.0


def _is_finite_nonneg(val: Any) -> bool:
    return isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(val) and val >= 0.0


def evaluate_trusted_clock_and_auth(
    *,
    snapshot_epoch_utc: int | float,
    now_utc: int | float,
    max_snapshot_age_sec: int = 5,
    max_future_skew_sec: int = 2,
    expected_account_login: int,
    expected_server: str,
    observed_account_login: int,
    observed_server: str,
    broker_contract_attested: bool,
) -> dict[str, Any]:
    """Validate snapshot freshness, clock skew, account/server binding, and broker contract."""
    if not broker_contract_attested:
        return {"ok": False, "reason": "BROKER_CONTRACT_NOT_ATTESTED"}
    if int(expected_account_login) <= 0 or int(observed_account_login) != int(expected_account_login):
        return {"ok": False, "reason": "ACCOUNT_BINDING_MISMATCH"}
    if not str(expected_server or "").strip() or str(observed_server or "").strip() != str(expected_server).strip():
        return {"ok": False, "reason": "SERVER_BINDING_MISMATCH"}
    if not _is_finite_pos(snapshot_epoch_utc) or not _is_finite_pos(now_utc):
        return {"ok": False, "reason": "INVALID_CLOCK_TIMESTAMP"}

    age_sec = float(now_utc) - float(snapshot_epoch_utc)
    if age_sec < -float(max_future_skew_sec):
        return {"ok": False, "reason": "CLOCK_FUTURE_SKEW_EXCEEDED", "ageSec": age_sec}
    if age_sec > float(max_snapshot_age_sec):
        return {"ok": False, "reason": "SNAPSHOT_STALE", "ageSec": age_sec}

    return {"ok": True, "reason": "TRUSTED_CLOCK_AND_AUTH_OK", "ageSec": age_sec}


def compute_entry_risk_usd(
    *,
    entry_price: float,
    stop_loss: float,
    volume_lots: float,
    tick_size: float,
    tick_value: float,
    commission_per_lot_rt: float = 0.0,
    swap_usd: float = 0.0,
    slippage_ticks: float = 0.0,
) -> dict[str, Any]:
    """Compute worst-case USD loss to SL plus commission, swap, and slippage."""
    if not (_is_finite_pos(entry_price) and _is_finite_pos(stop_loss) and _is_finite_pos(volume_lots)):
        return {"ok": False, "reason": "INVALID_PRICE_SL_OR_VOLUME"}
    if not (_is_finite_pos(tick_size) and _is_finite_pos(tick_value)):
        return {"ok": False, "reason": "INVALID_TICK_SPEC"}
    if not (_is_finite_nonneg(commission_per_lot_rt) and _is_finite_nonneg(slippage_ticks)):
        return {"ok": False, "reason": "INVALID_COST_PARAM"}
    if not (isinstance(swap_usd, (int, float)) and not isinstance(swap_usd, bool) and math.isfinite(swap_usd)):
        return {"ok": False, "reason": "INVALID_SWAP_PARAM"}

    sl_ticks = abs(float(entry_price) - float(stop_loss)) / float(tick_size)
    if sl_ticks <= 0.0:
        return {"ok": False, "reason": "ZERO_SL_DISTANCE"}

    price_risk_usd = (sl_ticks + float(slippage_ticks)) * float(tick_value) * float(volume_lots)
    commission_usd = float(commission_per_lot_rt) * float(volume_lots)
    adverse_swap_usd = max(0.0, -float(swap_usd))
    total_risk_usd = price_risk_usd + commission_usd + adverse_swap_usd

    return {
        "ok": True,
        "priceRiskUsd": price_risk_usd,
        "commissionUsd": commission_usd,
        "adverseSwapUsd": adverse_swap_usd,
        "totalRiskUsd": total_risk_usd,
    }


def evaluate_all_symbol_worst_case_exposure(
    *,
    positions: list[dict[str, Any]],
    pending_orders: list[dict[str, Any]],
    slippage_ticks: float = 0.0,
) -> dict[str, Any]:
    """Aggregate worst-case risk across ALL symbols for open positions & all 6 pending order types."""
    total_open_risk_usd = 0.0
    total_pending_risk_usd = 0.0
    symbols_seen: set[str] = set()

    for pos in positions:
        ticket = pos.get("ticket")
        if not isinstance(ticket, int) or isinstance(ticket, bool) or ticket <= 0:
            return {"ok": False, "reason": "INVALID_POSITION_TICKET"}
        if pos.get("type") not in POSITION_TYPES:
            return {"ok": False, "reason": "UNKNOWN_POSITION_TYPE", "ticket": ticket}
        symbol = str(pos.get("symbol") or "").strip()
        if not symbol:
            return {"ok": False, "reason": "MISSING_POSITION_SYMBOL", "ticket": ticket}
        symbols_seen.add(symbol)

        res = compute_entry_risk_usd(
            entry_price=pos.get("priceOpen"),
            stop_loss=pos.get("sl"),
            volume_lots=pos.get("volume"),
            tick_size=pos.get("tickSize"),
            tick_value=pos.get("tickValue"),
            commission_per_lot_rt=pos.get("commissionPerLotRt", 0.0),
            swap_usd=pos.get("swap", 0.0),
            slippage_ticks=slippage_ticks,
        )
        if not res["ok"]:
            return {"ok": False, "reason": f"POSITION_{res['reason']}", "ticket": ticket, "symbol": symbol}
        total_open_risk_usd += res["totalRiskUsd"]

    for order in pending_orders:
        ticket = order.get("ticket")
        if not isinstance(ticket, int) or isinstance(ticket, bool) or ticket <= 0:
            return {"ok": False, "reason": "INVALID_ORDER_TICKET"}
        order_type = order.get("type")
        if order_type not in PENDING_ORDER_TYPES:
            return {"ok": False, "reason": "UNKNOWN_PENDING_ORDER_TYPE", "ticket": ticket, "orderType": order_type}
        symbol = str(order.get("symbol") or "").strip()
        if not symbol:
            return {"ok": False, "reason": "MISSING_ORDER_SYMBOL", "ticket": ticket}
        symbols_seen.add(symbol)

        trigger_or_limit_price = order.get("stopLimitPrice") if (
            order_type in (6, 7) and _is_finite_pos(order.get("stopLimitPrice"))
        ) else order.get("priceOpen")

        res = compute_entry_risk_usd(
            entry_price=trigger_or_limit_price,
            stop_loss=order.get("sl"),
            volume_lots=order.get("volume"),
            tick_size=order.get("tickSize"),
            tick_value=order.get("tickValue"),
            commission_per_lot_rt=order.get("commissionPerLotRt", 0.0),
            swap_usd=0.0,
            slippage_ticks=slippage_ticks,
        )
        if not res["ok"]:
            return {"ok": False, "reason": f"PENDING_ORDER_{res['reason']}", "ticket": ticket, "symbol": symbol}
        total_pending_risk_usd += res["totalRiskUsd"]

    return {
        "ok": True,
        "symbols": sorted(symbols_seen),
        "openRiskUsd": total_open_risk_usd,
        "pendingRiskUsd": total_pending_risk_usd,
        "totalExposureRiskUsd": total_open_risk_usd + total_pending_risk_usd,
    }


def evaluate_shadow_auto_lot_p1(
    *,
    snapshot_epoch_utc: int | float,
    now_utc: int | float,
    expected_account_login: int,
    expected_server: str,
    observed_account_login: int,
    observed_server: str,
    broker_contract_attested: bool,
    equity_usd: float,
    max_total_risk_pct: float,
    candidate_entry_price: float,
    candidate_stop_loss: float,
    tick_size: float,
    tick_value: float,
    volume_min: float,
    volume_max: float,
    volume_step: float,
    commission_per_lot_rt: float = 0.0,
    slippage_ticks: float = 0.0,
    positions: list[dict[str, Any]] | None = None,
    pending_orders: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Shadow-only G2 Auto Lot sizing under full P1 contract checks."""
    base_envelope = {
        "shadowOnly": True,
        "executionEnabled": False,
        "activeSizingMode": "FIXED_LOT",
    }

    auth = evaluate_trusted_clock_and_auth(
        snapshot_epoch_utc=snapshot_epoch_utc,
        now_utc=now_utc,
        expected_account_login=expected_account_login,
        expected_server=expected_server,
        observed_account_login=observed_account_login,
        observed_server=observed_server,
        broker_contract_attested=broker_contract_attested,
    )
    if not auth["ok"]:
        return {**base_envelope, "admitted": False, "recommendedLot": 0.0, "reason": auth["reason"]}

    if not (_is_finite_pos(equity_usd) and _is_finite_pos(max_total_risk_pct) and max_total_risk_pct <= 1.0):
        return {**base_envelope, "admitted": False, "recommendedLot": 0.0, "reason": "INVALID_EQUITY_OR_RISK_PCT"}
    if not (_is_finite_pos(volume_min) and _is_finite_pos(volume_max) and _is_finite_pos(volume_step) and volume_min <= volume_max):
        return {**base_envelope, "admitted": False, "recommendedLot": 0.0, "reason": "INVALID_VOLUME_CONSTRAINTS"}

    exposure = evaluate_all_symbol_worst_case_exposure(
        positions=positions or [],
        pending_orders=pending_orders or [],
        slippage_ticks=slippage_ticks,
    )
    if not exposure["ok"]:
        return {**base_envelope, "admitted": False, "recommendedLot": 0.0, "reason": exposure["reason"]}

    per_lot = compute_entry_risk_usd(
        entry_price=candidate_entry_price,
        stop_loss=candidate_stop_loss,
        volume_lots=1.0,
        tick_size=tick_size,
        tick_value=tick_value,
        commission_per_lot_rt=commission_per_lot_rt,
        swap_usd=0.0,
        slippage_ticks=slippage_ticks,
    )
    if not per_lot["ok"]:
        return {**base_envelope, "admitted": False, "recommendedLot": 0.0, "reason": per_lot["reason"]}

    total_budget_usd = float(equity_usd) * float(max_total_risk_pct)
    remaining_budget_usd = total_budget_usd - exposure["totalExposureRiskUsd"]
    if remaining_budget_usd <= 0.0:
        return {
            **base_envelope,
            "admitted": False,
            "recommendedLot": 0.0,
            "reason": "PORTFOLIO_RISK_BUDGET_EXHAUSTED",
            "remainingBudgetUsd": remaining_budget_usd,
        }

    raw_lots = remaining_budget_usd / per_lot["totalRiskUsd"]
    steps = math.floor((raw_lots + 1e-12) / float(volume_step))
    floored_lots = round(steps * float(volume_step), 8)
    capped_lots = min(floored_lots, float(volume_max))
    if capped_lots < float(volume_min):
        return {
            **base_envelope,
            "admitted": False,
            "recommendedLot": 0.0,
            "reason": "BELOW_VOLUME_MIN_AFTER_COSTS",
            "remainingBudgetUsd": remaining_budget_usd,
        }

    return {
        **base_envelope,
        "admitted": True,
        "recommendedLot": capped_lots,
        "reason": "SHADOW_AUTO_LOT_COMPUTED",
        "remainingBudgetUsd": remaining_budget_usd,
        "perLotRiskUsd": per_lot["totalRiskUsd"],
        "symbolsIncluded": exposure["symbols"],
    }
