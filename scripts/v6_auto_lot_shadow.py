"""Offline/read-only broker-priced automatic lot candidate for issue #76.

NOT routed to V6 new-order execution. FIXED_LOT remains the only executable
mode until a separate approved gateway implementation and broker attestation.

A caller must independently verify quote freshness, daily budget, total
open/pending stop risk and round-trip trading costs from its MT5 session.
A flag is not proof of verification; this module cannot do it on its own.
It NEVER calls order_send, mutates orders, changes ARM or persists state.
"""
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_FLOOR
from math import isfinite

PER_TRADE_CEILING_PCT = 1.0
PORTFOLIO_CEILING_PCT = 1.5
MARGIN_RESERVE_FRACTION = 0.95
ADVERSE_GAP_BUFFER = 1.05
MAX_QUOTE_AGE_SEC = 60.0


def _num(value, *, positive=False):
    if isinstance(value, bool):
        return None
    try:
        x = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not isfinite(x) or (x <= 0 if positive else x < 0):
        return None
    return x


def _decimal(value):
    try:
        d = Decimal(str(value))
        return d if d.is_finite() and d > 0 else None
    except (InvalidOperation, TypeError, ValueError):
        return None


def recommend_broker_auto_lot_shadow(
    broker, account, symbol, side, entry_price, stop_loss_price, risk_percent,
    *, quote_fresh=False, quote_age_seconds=None,
    existing_sl_risk_usd=None, pending_sl_risk_usd=None,
    daily_remaining_risk_usd=None, costs_usd_per_lot=None,
    risk_inputs_verified=False, costs_verified=False, dca_layer=False,
):
    """Recommend broker-compatible size or no candidate; cannot submit an order."""
    def reject(code, reason):
        return {
            "ok": False, "mode": "AUTO_RISK_PERCENT_SHADOW",
            "executionEnabled": False, "candidateVolume": None,
            "status": code, "reason": reason,
        }

    if dca_layer:
        return reject("BLOCKED_DCA_POLICY_UNVERIFIED", "DCA requires a separate approved risk policy")
    if risk_inputs_verified is not True or costs_verified is not True:
        return reject("BLOCKED_RISK_EVIDENCE_UNVERIFIED",
                      "Verified existing/pending/daily exposure and round-trip costs required")
    if side not in ("BUY", "SELL") or not isinstance(symbol, str) or not symbol.strip():
        return reject("BLOCKED_INVALID_INTENT", "Explicit symbol and BUY/SELL required")
    entry = _num(entry_price, positive=True)
    stop = _num(stop_loss_price, positive=True)
    if entry is None or stop is None or not (
        stop < entry if side == "BUY" else stop > entry
    ):
        return reject("BLOCKED_INVALID_STOP", "Broker-priced adverse SL required")
    age = _num(quote_age_seconds)
    if quote_fresh is not True or age is None or age > MAX_QUOTE_AGE_SEC:
        return reject("BLOCKED_QUOTE_UNVERIFIED", "Fresh broker Bid/Ask not independently verified")

    risk_pct = _num(risk_percent, positive=True)
    if risk_pct is None or risk_pct > PER_TRADE_CEILING_PCT:
        return reject("BLOCKED_RISK_POLICY", "Risk percent must be explicit, positive and <=1%")
    existing = _num(existing_sl_risk_usd)
    pending = _num(pending_sl_risk_usd)
    remaining_daily = _num(daily_remaining_risk_usd)
    costs = _num(costs_usd_per_lot)
    if None in (existing, pending, remaining_daily, costs):
        return reject("BLOCKED_RISK_EVIDENCE_UNVERIFIED", "Invalid risk/cost inputs")
    try:
        equity = _num(getattr(account, "equity", None), positive=True)
        free_margin = _num(getattr(account, "margin_free", None), positive=True)
        login = int(getattr(account, "login", 0))
        server = str(getattr(account, "server", "") or "").strip()
    except (TypeError, ValueError, OverflowError):
        return reject("BLOCKED_ACCOUNT_UNVERIFIED", "Broker account snapshot unavailable")
    if equity is None or free_margin is None or login <= 0 or not server:
        return reject("BLOCKED_ACCOUNT_UNVERIFIED", "Verified account identity/equity/free margin required")
    try:
        meta = broker.symbol_info(symbol)
        min_vol = _decimal(getattr(meta, "volume_min", None))
        max_vol = _decimal(getattr(meta, "volume_max", None))
        step = _decimal(getattr(meta, "volume_step", None))
    except Exception:
        return reject("BLOCKED_SYMBOL_UNVERIFIED", "Broker volume bounds unavailable")
    if min_vol is None or max_vol is None or step is None or min_vol > max_vol:
        return reject("BLOCKED_SYMBOL_UNVERIFIED", "Invalid broker volume bounds")
    min_steps = int((min_vol / step).to_integral_value(rounding=ROUND_CEILING))
    max_steps = int((max_vol / step).to_integral_value(rounding=ROUND_FLOOR))
    if min_steps <= 0 or max_steps < min_steps:
        return reject("BLOCKED_SYMBOL_UNVERIFIED", "No broker-compliant order size")

    calc_profit = getattr(broker, "order_calc_profit", None)
    calc_margin = getattr(broker, "order_calc_margin", None)
    if not callable(calc_profit) or not callable(calc_margin):
        return reject("BLOCKED_BROKER_PRICING_UNVERIFIED",
                      "Mandatory broker SL-profit and margin calculation APIs unavailable")
    risk_budget = min(
        equity * risk_pct / 100,
        equity * PORTFOLIO_CEILING_PCT / 100 - existing - pending,
        remaining_daily,
    )
    if not isfinite(risk_budget) or risk_budget <= 0:
        return reject("BLOCKED_RISK_BUDGET_EXHAUSTED", "No verified new-order risk budget")

    order_type = getattr(broker, "ORDER_TYPE_BUY", 0) if side == "BUY" else getattr(broker, "ORDER_TYPE_SELL", 1)
    def price_at(steps):
        lot = float(step * steps)
        try:
            result = float(calc_profit(order_type, symbol, lot, entry, stop))
            margin = float(calc_margin(order_type, symbol, lot, entry))
        except Exception:
            return None
        if not (isfinite(result) and result < 0 and isfinite(margin) and margin > 0):
            return None
        # Positive costs must be explicitly verified upstream, not guessed.
        loss = -result * ADVERSE_GAP_BUFFER + costs * lot
        if not isfinite(loss) or loss <= 0:
            return None
        return lot, loss, margin

    base = price_at(min_steps)
    if base is None:
        return reject("BLOCKED_BROKER_PRICING_UNVERIFIED", "Cannot price broker minimum-lot adverse SL/margin")
    if base[1] > risk_budget or base[2] > free_margin * MARGIN_RESERVE_FRACTION:
        return reject("BLOCKED_MIN_LOT_EXCEEDS_RISK_OR_MARGIN",
                      "Even broker minimum lot would exceed risk budget or reserved margin")

    # Integer step binary search ensures rounding DOWN, never round-to-nearest
    # or floor then force the broker minimum up above the account risk budget.
    best, best_values = min_steps, base
    low, high = min_steps + 1, max_steps
    while low <= high:
        mid = (low + high) // 2
        candidate = price_at(mid)
        if candidate is None:
            return reject("BLOCKED_BROKER_PRICING_UNVERIFIED", "Broker pricing failed during candidate search")
        if candidate[1] <= risk_budget and candidate[2] <= free_margin * MARGIN_RESERVE_FRACTION:
            best, best_values, low = mid, candidate, mid + 1
        else:
            high = mid - 1

    return {
        "ok": True,
        "mode": "AUTO_RISK_PERCENT_SHADOW",
        "executionEnabled": False,
        "status": "BROKER_PRICED_SHADOW_CANDIDATE",
        "candidateVolume": best_values[0],
        "requestedRiskPercent": risk_pct,
        "riskBudgetUsd": round(risk_budget, 4),
        "estimatedAdverseSlLossWithCostUsd": round(best_values[1], 4),
        "requiredMarginUsd": round(best_values[2], 4),
        "verifiedAtAccount": {"login": login, "server": server},
        "brokerVolumeStep": float(step),
        "brokerVolumeMin": float(min_vol),
        "basis": "BROKER_CALC_PROFIT_AND_MARGIN_READONLY_INPUT_ASSUMPTIONS",
        "warning": "Not routed to V6. Snapshot flags are caller attestations, not actual broker-runtime acceptance.",
    }
