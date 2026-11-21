"""Read-only, offline broker evidence for an uncertain V6 entry (#7).

This pure function NEVER releases the existing persistent entry freeze, never
retries a request, and never sends or modifies an MT5 order. It is deliberately
NOT imported by the live execution gateway. It accepts already collected broker
snapshots, including pending orders that the older fill-evidence view omitted.
"""
from math import isfinite


def _positive_number(value):
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if isfinite(number) and number > 0 else None


def _positive_ticket(value):
    if isinstance(value, bool):
        return None
    try:
        result = int(value)
        if result <= 0 or str(result) != str(value).strip():
            return None
        return result
    except (TypeError, ValueError, OverflowError):
        return None


def _blocked(reason, *, deal_count=0, pending_count=0, observed_volume=None):
    """Evidence can inform manual review but can never authorize a new send."""
    return {
        "status": reason,
        "freezeNewOrders": True,
        "allowDuplicateSend": False,
        "allowAutomaticFreezeClear": False,
        "allowProtectivePositionManagement": True,
        "matchedDealCount": deal_count,
        "matchedPendingCount": pending_count,
        "observedDealVolume": observed_volume,
        "verificationScope": "OFFLINE_BROKER_EVIDENCE_NOT_RUNTIME_AUTHORIZATION",
    }


def assess_uncertain_entry_evidence(
    *,
    intent,
    snapshot_login,
    snapshot_server,
    broker_positions,
    broker_pending_orders,
    broker_deals,
    bot_magic=270715,
):
    """Inspect evidence for exactly one persisted broker intent.

    This does not claim a *missing* fill is proof an order was never accepted:
    broker history windows and transient readbacks may be incomplete.
    Both full and partial fills still require separately authorized reconciliation.
    """
    if not isinstance(intent, dict):
        return _blocked("INTENT_UNVERIFIED")
    symbol = str(intent.get("symbol") or "").strip().upper()
    side = str(intent.get("side") or "").strip().upper()
    comment = str(intent.get("brokerComment") or "").strip()
    req_vol = _positive_number(intent.get("requestedVolume"))
    saved_login = _positive_ticket(intent.get("accountLogin"))
    live_login = _positive_ticket(snapshot_login)
    saved_server = str(intent.get("server") or "").strip()
    live_server = str(snapshot_server or "").strip()
    magic = _positive_ticket(bot_magic)
    if not (symbol and side in ("BUY", "SELL") and comment and len(comment) <= 31
            and req_vol and saved_login and saved_server and magic):
        return _blocked("INTENT_UNVERIFIED")
    if live_login != saved_login or not live_server or live_server.casefold() != saved_server.casefold():
        return _blocked("ACCOUNT_SERVER_MISMATCH")
    if not all(isinstance(items, (list, tuple))
               for items in (broker_positions, broker_pending_orders, broker_deals)):
        return _blocked("BROKER_SNAPSHOT_UNAVAILABLE")
    if any(not isinstance(item, dict) for group in (broker_positions, broker_pending_orders, broker_deals)
           for item in group):
        return _blocked("BROKER_SNAPSHOT_MALFORMED")

    def owned_and_linked(item):
        try:
            return (int(item.get("magic")) == magic
                    and str(item.get("symbol") or "").strip().upper() == symbol
                    and str(item.get("comment") or "").strip() == comment)
        except (TypeError, ValueError, OverflowError):
            return False

    deals = [d for d in broker_deals if owned_and_linked(d)]
    pending = [o for o in broker_pending_orders if owned_and_linked(o)]
    deal_type = 0 if side == "BUY" else 1
    if any(_positive_ticket(d.get("ticket")) is None
           or _positive_number(d.get("volume")) is None
           or d.get("type") != deal_type for d in deals):
        return _blocked("MATCHED_DEAL_INVALID")
    if any(_positive_ticket(p.get("ticket")) is None for p in pending):
        return _blocked("MATCHED_PENDING_INVALID")
    deal_ids = [_positive_ticket(d["ticket"]) for d in deals]
    pending_ids = [_positive_ticket(p["ticket"]) for p in pending]
    if len(deal_ids) != len(set(deal_ids)) or len(pending_ids) != len(set(pending_ids)):
        return _blocked("DUPLICATE_BROKER_RECORDS")

    total = round(sum(float(d["volume"]) for d in deals), 8)
    count, pending_count = len(deals), len(pending)
    if pending_count > 0:
        return _blocked("BROKER_PENDING_ORDER_REVIEW", deal_count=count,
                        pending_count=pending_count, observed_volume=total)
    if not deals:
        return _blocked("NO_MATCH_NOT_PROOF_OF_NO_FILL")
    tolerance = max(1e-8, req_vol * 1e-6)
    if total > req_vol + tolerance:
        return _blocked("BROKER_OVERFILL_REVIEW", deal_count=count, observed_volume=total)
    if total < req_vol - tolerance:
        return _blocked("BROKER_PARTIAL_FILL_REVIEW", deal_count=count, observed_volume=total)

    # Position linkage may be unavailable if the position has since closed.
    # Do not infer absence of execution from absent current position.
    position_ids = {
        _positive_ticket(d.get("position_id"))
        for d in deals if _positive_ticket(d.get("position_id")) is not None
    }
    linked = []
    for p in broker_positions:
        position_id = _positive_ticket(p.get("identifier"))
        try:
            belongs = int(p.get("magic")) == magic
        except (TypeError, ValueError, OverflowError):
            belongs = False
        if (position_id in position_ids and belongs
                and str(p.get("symbol") or "").strip().upper() == symbol):
            linked.append(p)
    status = "BROKER_FULL_FILL_POSITION_OBSERVED_REVIEW" if linked else "BROKER_FULL_FILL_HISTORY_ONLY_REVIEW"
    return _blocked(status, deal_count=count, observed_volume=total)
