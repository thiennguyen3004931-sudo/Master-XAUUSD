"""G2 P1 non-authorizing Auto Lot what-if contract (#76).

All inventories, clock, pricing callbacks, costs and contract flags are caller
supplied and NOT broker-authenticated. This module does not import MT5, send
orders, change risk mode, arm LIVE or approve any executable volume.
A calculated lot is ONLY an unverified, read-only shadow diagnostic.
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_FLOOR
import math
from typing import Any, Callable

PENDING_ORDER_TYPES = {
    2: "BUY_LIMIT", 3: "SELL_LIMIT", 4: "BUY_STOP", 5: "SELL_STOP",
    6: "BUY_STOP_LIMIT", 7: "SELL_STOP_LIMIT",
}
POSITION_TYPES = {0: "BUY", 1: "SELL"}
SHADOW_ONLY = {
    "shadowOnly": True,
    "executionEnabled": False,
    "runtimePreSendAccepted": False,
    "liveAuthorized": False,
    "admitted": False,
    "activeSizingMode": "FIXED_LOT",
    "brokerContractIndependentlyVerified": False,
    "brokerCostIndependentlyVerified": False,
    "clockIndependentlyVerified": False,
    "dataProvenance": "CALLER_SUPPLIED_NONATOMIC_NOT_BROKER_ATTESTED",
}


def _pos(v: Any) -> bool:
    return (isinstance(v, (int, float)) and not isinstance(v, bool)
            and math.isfinite(v) and v > 0)


def _nonneg(v: Any) -> bool:
    return (isinstance(v, (int, float)) and not isinstance(v, bool)
            and math.isfinite(v) and v >= 0)


def _reject(reason: str, **extra: Any) -> dict[str, Any]:
    return {**SHADOW_ONLY, "shadowCandidateAvailable": False,
            "recommendedLot": 0.0, "reason": reason, **extra}


def evaluate_trusted_clock_and_auth(
    *, snapshot_epoch_utc: int | float, now_utc: int | float,
    max_snapshot_age_sec: int = 5, max_future_skew_sec: int = 2,
    expected_account_login: int, expected_server: str,
    observed_account_login: int, observed_server: str,
    broker_contract_attested: bool,
) -> dict[str, Any]:
    """Check caller-claimed freshness/binding, never authenticate a broker."""
    if broker_contract_attested is not True:
        return {"ok": False, "reason": "BROKER_CONTRACT_CLAIM_MISSING"}
    if (not isinstance(expected_account_login, int)
            or isinstance(expected_account_login, bool)
            or not isinstance(observed_account_login, int)
            or isinstance(observed_account_login, bool)
            or expected_account_login <= 0
            or expected_account_login != observed_account_login):
        return {"ok": False, "reason": "ACCOUNT_BINDING_MISMATCH"}
    if (not isinstance(expected_server, str)
            or not isinstance(observed_server, str)
            or not expected_server.strip()
            or expected_server.strip() != observed_server.strip()):
        return {"ok": False, "reason": "SERVER_BINDING_MISMATCH"}
    if (not _pos(snapshot_epoch_utc) or not _pos(now_utc)):
        return {"ok": False, "reason": "INVALID_CLOCK_TIMESTAMP"}
    if (not _pos(max_snapshot_age_sec) or max_snapshot_age_sec > 30
            or not _nonneg(max_future_skew_sec) or max_future_skew_sec > 5):
        return {"ok": False, "reason": "INVALID_FRESHNESS_BOUNDS"}
    age = float(now_utc) - float(snapshot_epoch_utc)
    if age < -float(max_future_skew_sec):
        return {"ok": False, "reason": "CLOCK_FUTURE_SKEW_EXCEEDED"}
    if age > float(max_snapshot_age_sec):
        return {"ok": False, "reason": "SNAPSHOT_STALE"}
    return {
        "ok": True, "reason": "CALLER_CLAIMED_CLOCK_AND_IDENTITY_MATCH",
        "ageSec": age, "clockIndependentlyVerified": False,
        "brokerContractIndependentlyVerified": False,
    }


def compute_entry_risk_usd(
    *, side: str, symbol: str, entry_price: float, stop_loss: float,
    volume_lots: float, tick_size: float, tick_value: float,
    broker_profit_calculator: Callable | None,
    commission_per_lot_rt: float = 0.0, swap_usd: float = 0.0,
    slippage_ticks: float = 0.0,
) -> dict[str, Any]:
    """Read-only what-if: *negative* calculator P/L at stop plus assumed costs.

    Profit calculator signature: (side, symbol, lots, price_from, price_to)
    -> USD P/L, negative for loss. The injected callable is NOT a trusted
    broker-attested API; its outputs are diagnostic only.
    """
    if side not in ("BUY", "SELL") or not isinstance(symbol, str) or not symbol.strip():
        return {"ok": False, "reason": "INVALID_SIDE_OR_SYMBOL"}
    if not all(_pos(x) for x in (entry_price, stop_loss, volume_lots)):
        return {"ok": False, "reason": "INVALID_PRICE_SL_OR_VOLUME"}
    if ((side == "BUY" and stop_loss >= entry_price)
            or (side == "SELL" and stop_loss <= entry_price)):
        return {"ok": False, "reason": "STOP_WRONG_SIDE_OR_NO_ADVERSE_GAP"}
    if not _pos(tick_size) or not _pos(tick_value):
        return {"ok": False, "reason": "INVALID_TICK_SPEC"}
    if not _nonneg(commission_per_lot_rt) or not _nonneg(slippage_ticks):
        return {"ok": False, "reason": "INVALID_COST_PARAM"}
    if (not isinstance(swap_usd, (int, float)) or isinstance(swap_usd, bool)
            or not math.isfinite(swap_usd)):
        return {"ok": False, "reason": "INVALID_SWAP_PARAM"}
    if not callable(broker_profit_calculator):
        return {"ok": False, "reason": "BROKER_PRICING_UNAVAILABLE"}
    try:
        at_sl_profit = broker_profit_calculator(
            side, symbol.strip(), float(volume_lots),
            float(entry_price), float(stop_loss),
        )
    except Exception:
        return {"ok": False, "reason": "BROKER_PRICING_EXCEPTION"}
    if (not isinstance(at_sl_profit, (int, float))
            or isinstance(at_sl_profit, bool) or not math.isfinite(at_sl_profit)
            or at_sl_profit >= 0):
        return {"ok": False, "reason": "BROKER_STOP_LOSS_NOT_VERIFIABLE"}
    loss = -float(at_sl_profit)
    slip = float(slippage_ticks) * float(tick_value) * float(volume_lots)
    commission = float(commission_per_lot_rt) * float(volume_lots)
    adverse_swap = max(0.0, -float(swap_usd))
    total = loss + slip + commission + adverse_swap
    if not _pos(total):
        return {"ok": False, "reason": "INVALID_TOTAL_RISK"}
    return {
        "ok": True, "priceRiskUsd": loss, "slippageBufferUsd": slip,
        "commissionUsd": commission, "adverseSwapUsd": adverse_swap,
        "totalRiskUsd": total,
        "brokerProfitIndependentlyVerified": False,
    }


def evaluate_all_symbol_worst_case_exposure(
    *, positions: list[dict[str, Any]] | None,
    pending_orders: list[dict[str, Any]] | None,
    broker_profit_calculator: Callable | None,
    slippage_ticks: float = 0.0,
) -> dict[str, Any]:
    """Conservative portfolio what-if; an unreadable feed is NOT zero exposure."""
    if not isinstance(positions, list) or not isinstance(pending_orders, list):
        return {"ok": False, "reason": "BROKER_INVENTORY_UNVERIFIED"}
    if not _nonneg(slippage_ticks):
        return {"ok": False, "reason": "INVALID_COST_PARAM"}
    if not callable(broker_profit_calculator):
        return {"ok": False, "reason": "BROKER_PRICING_UNAVAILABLE"}
    opened = 0.0
    pending = 0.0
    symbols: set[str] = set()
    position_ids: set[int] = set()
    pending_ids: set[int] = set()

    for pos in positions:
        if not isinstance(pos, dict):
            return {"ok": False, "reason": "INVALID_POSITION_RECORD"}
        ticket = pos.get("ticket")
        if not isinstance(ticket, int) or isinstance(ticket, bool) or ticket <= 0 or ticket in position_ids:
            return {"ok": False, "reason": "INVALID_OR_DUPLICATE_POSITION_TICKET"}
        position_ids.add(ticket)
        kind = pos.get("type")
        if not isinstance(kind, int) or isinstance(kind, bool) or kind not in POSITION_TYPES:
            return {"ok": False, "reason": "UNKNOWN_POSITION_TYPE"}
        symbol = pos.get("symbol")
        if not isinstance(symbol, str) or not symbol.strip():
            return {"ok": False, "reason": "MISSING_POSITION_SYMBOL"}
        symbols.add(symbol.strip())
        # Portfolio loss budget must be measured from CURRENT closing quote
        # (BUY BID / SELL ASK), never position priceOpen (BE/trailing SL).
        risk = compute_entry_risk_usd(
            side=POSITION_TYPES[kind], symbol=symbol,
            entry_price=pos.get("markPrice"), stop_loss=pos.get("sl"),
            volume_lots=pos.get("volume"), tick_size=pos.get("tickSize"),
            tick_value=pos.get("tickValue"),
            broker_profit_calculator=broker_profit_calculator,
            commission_per_lot_rt=pos.get("commissionPerLotRt"),
            swap_usd=pos.get("swap"), slippage_ticks=slippage_ticks,
        )
        if not risk["ok"]:
            return {"ok": False, "reason": "POSITION_" + risk["reason"], "ticket": ticket}
        opened += risk["totalRiskUsd"]

    for order in pending_orders:
        if not isinstance(order, dict):
            return {"ok": False, "reason": "INVALID_PENDING_RECORD"}
        ticket = order.get("ticket")
        if not isinstance(ticket, int) or isinstance(ticket, bool) or ticket <= 0 or ticket in pending_ids:
            return {"ok": False, "reason": "INVALID_OR_DUPLICATE_PENDING_TICKET"}
        pending_ids.add(ticket)
        kind = order.get("type")
        if not isinstance(kind, int) or isinstance(kind, bool) or kind not in PENDING_ORDER_TYPES:
            return {"ok": False, "reason": "UNKNOWN_PENDING_ORDER_TYPE"}
        symbol = order.get("symbol")
        if not isinstance(symbol, str) or not symbol.strip():
            return {"ok": False, "reason": "MISSING_PENDING_SYMBOL"}
        symbols.add(symbol.strip())
        side = "BUY" if kind in (2, 4, 6) else "SELL"
        trigger = order.get("priceOpen")
        if not _pos(trigger):
            return {"ok": False, "reason": "PENDING_TRIGGER_UNVERIFIED"}
        if kind in (6, 7):
            limit = order.get("stopLimitPrice")
            if not _pos(limit):
                return {"ok": False, "reason": "STOP_LIMIT_SECONDARY_PRICE_UNVERIFIED"}
            # Conservative for both possible price points, plus buffer.
            worst_fill = max(trigger, limit) if side == "BUY" else min(trigger, limit)
        else:
            worst_fill = trigger
        risk = compute_entry_risk_usd(
            side=side, symbol=symbol, entry_price=worst_fill,
            stop_loss=order.get("sl"), volume_lots=order.get("volume"),
            tick_size=order.get("tickSize"), tick_value=order.get("tickValue"),
            broker_profit_calculator=broker_profit_calculator,
            commission_per_lot_rt=order.get("commissionPerLotRt"),
            swap_usd=0.0, slippage_ticks=slippage_ticks,
        )
        if not risk["ok"]:
            return {"ok": False, "reason": "PENDING_" + risk["reason"], "ticket": ticket}
        pending += risk["totalRiskUsd"]

    total = opened + pending
    if not _nonneg(total):
        return {"ok": False, "reason": "UNVERIFIED_PORTFOLIO_RISK"}
    return {
        "ok": True, "symbols": sorted(symbols), "openRiskUsd": opened,
        "pendingRiskUsd": pending, "totalExposureRiskUsd": total,
        "pricingIndependentlyVerified": False,
    }


def _grid_floor(*, available: float, volume_min: float, volume_max: float, volume_step: float) -> float | None:
    """Broker volume lattice must be respected even at non-grid max volume."""
    try:
        dmin = Decimal(str(volume_min))
        dmax = Decimal(str(volume_max))
        step = Decimal(str(volume_step))
        ceiling = min(Decimal(str(available)), dmax)
        if not (step > 0 and dmin > 0 and dmax >= dmin and ceiling >= dmin):
            return None
        if dmin % step != 0:
            return None
        nsteps = ((ceiling - dmin) / step).to_integral_value(rounding=ROUND_FLOOR)
        lot = dmin + nsteps * step
        if not (dmin <= lot <= ceiling and lot <= dmax):
            return None
        result = float(lot)
        return result if _pos(result) else None
    except (InvalidOperation, OverflowError, ValueError, TypeError):
        return None


def evaluate_shadow_auto_lot_p1(
    *, snapshot_epoch_utc: int | float, now_utc: int | float,
    expected_account_login: int, expected_server: str,
    observed_account_login: int, observed_server: str,
    broker_contract_attested: bool, equity_usd: float,
    max_total_risk_pct: float, candidate_side: str, candidate_symbol: str,
    candidate_entry_price: float, candidate_stop_loss: float,
    tick_size: float, tick_value: float, volume_min: float,
    volume_max: float, volume_step: float,
    broker_profit_calculator: Callable | None = None,
    commission_per_lot_rt: float = 0.0, slippage_ticks: float = 0.0,
    positions: list[dict[str, Any]] | None = None,
    pending_orders: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Calculate a NON-EXECUTABLE candidate. No trusted source is established."""
    auth = evaluate_trusted_clock_and_auth(
        snapshot_epoch_utc=snapshot_epoch_utc, now_utc=now_utc,
        expected_account_login=expected_account_login, expected_server=expected_server,
        observed_account_login=observed_account_login, observed_server=observed_server,
        broker_contract_attested=broker_contract_attested,
    )
    if not auth["ok"]:
        return _reject(auth["reason"])
    if positions is None or pending_orders is None:
        return _reject("BROKER_INVENTORY_UNVERIFIED")
    if (not _pos(equity_usd) or not _pos(max_total_risk_pct)
            or max_total_risk_pct > 0.1):
        return _reject("INVALID_EQUITY_OR_RISK_PCT")
    if not all(_pos(x) for x in (volume_min, volume_max, volume_step)):
        return _reject("INVALID_VOLUME_CONSTRAINTS")
    if volume_min > volume_max or volume_step > volume_max:
        return _reject("INVALID_VOLUME_CONSTRAINTS")
    if _grid_floor(available=volume_max, volume_min=volume_min,
                   volume_max=volume_max, volume_step=volume_step) is None:
        return _reject("INVALID_VOLUME_GRID")
    if not callable(broker_profit_calculator):
        return _reject("BROKER_PRICING_UNAVAILABLE")

    exposure = evaluate_all_symbol_worst_case_exposure(
        positions=positions, pending_orders=pending_orders,
        broker_profit_calculator=broker_profit_calculator,
        slippage_ticks=slippage_ticks,
    )
    if not exposure["ok"]:
        return _reject(exposure["reason"])

    total_budget = float(equity_usd) * float(max_total_risk_pct)
    remaining = total_budget - exposure["totalExposureRiskUsd"]
    if not _pos(remaining):
        return _reject("PORTFOLIO_RISK_BUDGET_EXHAUSTED", remainingBudgetUsd=remaining)

    # Broker calculator invoked for valid minimum volume and final candidate.
    # Never authorize a lot from a linear tick-value shortcut.
    min_risk = compute_entry_risk_usd(
        side=candidate_side, symbol=candidate_symbol,
        entry_price=candidate_entry_price, stop_loss=candidate_stop_loss,
        volume_lots=volume_min, tick_size=tick_size, tick_value=tick_value,
        broker_profit_calculator=broker_profit_calculator,
        commission_per_lot_rt=commission_per_lot_rt,
        slippage_ticks=slippage_ticks,
    )
    if not min_risk["ok"]:
        return _reject("CANDIDATE_" + min_risk["reason"])
    estimated_lots = remaining / min_risk["totalRiskUsd"] * float(volume_min)
    lot = _grid_floor(
        available=estimated_lots, volume_min=volume_min,
        volume_max=volume_max, volume_step=volume_step,
    )
    if lot is None:
        return _reject("BELOW_VOLUME_MIN_AFTER_COSTS", remainingBudgetUsd=remaining)

    # A tiered/nonlinear calculator can quote higher risk at final lot.
    final_risk = compute_entry_risk_usd(
        side=candidate_side, symbol=candidate_symbol,
        entry_price=candidate_entry_price, stop_loss=candidate_stop_loss,
        volume_lots=lot, tick_size=tick_size, tick_value=tick_value,
        broker_profit_calculator=broker_profit_calculator,
        commission_per_lot_rt=commission_per_lot_rt,
        slippage_ticks=slippage_ticks,
    )
    if not final_risk["ok"] or final_risk["totalRiskUsd"] > remaining + 1e-9:
        return _reject("FINAL_BROKER_PRICED_RISK_UNVERIFIED_OR_OVER_BUDGET")

    return {
        **SHADOW_ONLY,
        "shadowCandidateAvailable": True,
        "recommendedLot": lot, "reason": "UNVERIFIED_SHADOW_CANDIDATE_ONLY",
        "remainingBudgetUsd": remaining,
        "candidateRiskUsd": final_risk["totalRiskUsd"],
        "symbolsIncluded": exposure["symbols"],
    }
