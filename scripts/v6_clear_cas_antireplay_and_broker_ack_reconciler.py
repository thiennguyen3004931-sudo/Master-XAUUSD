#!/usr/bin/env python3
"""Offline/source-only V6 G1 (#7) CLEAR CAS/anti-replay audit contract and broker ACK/partial-fill reconciler."""

from __future__ import annotations

import copy
import hashlib
import json
import math
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = 1
MAX_CLEAR_TTL_SECONDS = 300
MIN_NONCE_LENGTH = 16
VOLUME_EPSILON = 1e-9
HEX_CHARS = set("0123456789abcdef")

REJECTED_NO_EXPOSURE_RETCODES: set[int] = {
    10004,
    10006,
    10007,
    10013,
    10014,
    10015,
    10016,
    10017,
    10018,
    10019,
    10021,
    10026,
    10027,
}

VALID_DIRECTIONS: set[str] = {"BUY", "SELL"}


def _is_positive_int(val: Any) -> bool:
    return type(val) is int and val > 0


def _is_finite_positive_number(val: Any) -> bool:
    if isinstance(val, bool) or not isinstance(val, (int, float)):
        return False
    f = float(val)
    return math.isfinite(f) and f > 0.0


def _is_sha256_hex(val: str) -> bool:
    return len(val) == 64 and all(ch in HEX_CHARS for ch in val)


def _sha256_canonical(payload: Mapping[str, Any], *, exclude_keys: set[str] | None = None) -> str:
    skip = exclude_keys or set()
    body = {k: v for k, v in payload.items() if k not in skip}
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def verify_audit_chain(audit_chain: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Verify hash-chained CLEAR/STOP audit entries for tamper evidence."""
    if not isinstance(audit_chain, Sequence):
        return {"valid": False, "reason": "AUDIT_CHAIN_NOT_SEQUENCE", "length": 0}

    expected_prev = "GENESIS"
    for idx, entry in enumerate(audit_chain):
        if not isinstance(entry, Mapping):
            return {"valid": False, "reason": f"ENTRY_{idx}_NOT_MAPPING", "length": len(audit_chain)}
        if entry.get("prevAuditSha256") != expected_prev:
            return {
                "valid": False,
                "reason": f"ENTRY_{idx}_PREV_HASH_MISMATCH",
                "length": len(audit_chain),
            }
        expected_hash = _sha256_canonical(entry, exclude_keys={"entrySha256"})
        if entry.get("entrySha256") != expected_hash:
            return {
                "valid": False,
                "reason": f"ENTRY_{idx}_HASH_MISMATCH",
                "length": len(audit_chain),
            }
        expected_prev = expected_hash

    return {"valid": True, "reason": "AUDIT_CHAIN_VERIFIED", "length": len(audit_chain)}


def validate_and_apply_clear_cas(
    *,
    current_state: Mapping[str, Any],
    clear_request: Mapping[str, Any],
    now_utc: int,
) -> dict[str, Any]:
    """Validate a CLEAR request with CAS generation, anti-replay nonce, and trust preconditions.

    Always returns ``liveAuthorized: False``. Does not mutate caller inputs.
    """
    state = copy.deepcopy(dict(current_state))
    current_gen = state.get("generation")
    if type(current_gen) is not int or current_gen < 0:
        return {
            "accepted": False,
            "reason": "INVALID_STATE_GENERATION",
            "state": state,
            "liveAuthorized": False,
        }

    audit_chain = list(state.get("auditChain") or [])
    chain_check = verify_audit_chain(audit_chain)
    if not chain_check["valid"]:
        return {
            "accepted": False,
            "reason": f"AUDIT_CHAIN_CORRUPTED:{chain_check['reason']}",
            "state": state,
            "liveAuthorized": False,
        }

    expected_gen = clear_request.get("expectedGeneration")
    if type(expected_gen) is not int or expected_gen != current_gen:
        return {
            "accepted": False,
            "reason": "CAS_GENERATION_MISMATCH",
            "state": state,
            "liveAuthorized": False,
        }

    nonce = str(clear_request.get("nonce") or "").strip()
    if len(nonce) < MIN_NONCE_LENGTH:
        return {
            "accepted": False,
            "reason": "CLEAR_NONCE_TOO_SHORT",
            "state": state,
            "liveAuthorized": False,
        }

    consumed_nonces = list(state.get("consumedNonces") or [])
    if nonce in consumed_nonces:
        return {
            "accepted": False,
            "reason": "CLEAR_NONCE_REPLAY_DETECTED",
            "state": state,
            "liveAuthorized": False,
        }

    issued_at = clear_request.get("issuedAtUtc")
    expires_at = clear_request.get("expiresAtUtc")
    if (
        type(issued_at) is not int
        or type(expires_at) is not int
        or type(now_utc) is not int
        or expires_at <= issued_at
        or (expires_at - issued_at) > MAX_CLEAR_TTL_SECONDS
        or now_utc < issued_at
        or now_utc > expires_at
    ):
        return {
            "accepted": False,
            "reason": "CLEAR_EXPIRED_OR_INVALID_WINDOW",
            "state": state,
            "liveAuthorized": False,
        }

    state_login = state.get("accountLogin")
    req_login = clear_request.get("accountLogin")
    if not _is_positive_int(state_login) or not _is_positive_int(req_login) or state_login != req_login:
        return {
            "accepted": False,
            "reason": "CLEAR_BINDING_MISMATCH:accountLogin",
            "state": state,
            "liveAuthorized": False,
        }

    binding_pairs = (
        ("server", str(state.get("server") or "").strip(), str(clear_request.get("server") or "").strip()),
        (
            "releaseCommitSha",
            str(state.get("releaseCommitSha") or "").strip().lower(),
            str(clear_request.get("releaseCommitSha") or "").strip().lower(),
        ),
    )
    for field_name, state_val, req_val in binding_pairs:
        if not state_val or state_val != req_val:
            return {
                "accepted": False,
                "reason": f"CLEAR_BINDING_MISMATCH:{field_name}",
                "state": state,
                "liveAuthorized": False,
            }

    preconditions = (
        ("hostAclVerified", clear_request.get("hostAclVerified") is True),
        ("dpapiServiceIdentityVerified", clear_request.get("dpapiServiceIdentityVerified") is True),
        ("brokerReconciliationClean", clear_request.get("brokerReconciliationClean") is True),
        ("signatureVerified", clear_request.get("signatureVerified") is True),
    )
    missing_preconditions = [name for name, ok in preconditions if not ok]
    if missing_preconditions:
        return {
            "accepted": False,
            "reason": f"CLEAR_TRUST_PRECONDITION_UNMET:{','.join(missing_preconditions)}",
            "state": state,
            "liveAuthorized": False,
        }

    operator_sid_sha256 = str(clear_request.get("operatorSidSha256") or "").strip().lower()
    if not _is_sha256_hex(operator_sid_sha256):
        return {
            "accepted": False,
            "reason": "CLEAR_OPERATOR_SID_HASH_INVALID",
            "state": state,
            "liveAuthorized": False,
        }

    next_gen = current_gen + 1
    prev_hash = audit_chain[-1]["entrySha256"] if audit_chain else "GENESIS"
    audit_entry: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "action": "AUTHORIZED_CLEAR",
        "fromGeneration": current_gen,
        "toGeneration": next_gen,
        "appliedAtUtc": now_utc,
        "nonce": nonce,
        "accountLogin": state_login,
        "server": state["server"],
        "releaseCommitSha": state["releaseCommitSha"],
        "operatorSidSha256": operator_sid_sha256,
        "prevAuditSha256": prev_hash,
    }
    audit_entry["entrySha256"] = _sha256_canonical(audit_entry)

    new_state = dict(state)
    new_state["generation"] = next_gen
    new_state["emergencyStopActive"] = False
    new_state["blockNewOrders"] = False
    new_state["lastAction"] = "AUTHORIZED_CLEAR"
    new_state["lastUpdatedAtUtc"] = now_utc
    new_state["consumedNonces"] = consumed_nonces + [nonce]
    new_state["auditChain"] = audit_chain + [audit_entry]
    new_state["liveAuthorized"] = False

    return {
        "accepted": True,
        "reason": "CLEAR_CAS_APPLIED_AUDIT_CHAINED",
        "state": new_state,
        "auditEntry": audit_entry,
        "liveAuthorized": False,
    }


def reconcile_broker_ack_and_fills(
    *,
    intent: Mapping[str, Any],
    broker_ack: Mapping[str, Any],
    observed_deals: Sequence[Mapping[str, Any]],
    observed_pending_orders: Sequence[Mapping[str, Any]] = (),
) -> dict[str, Any]:
    """Reconcile broker ACK, opening DEAL_ENTRY_IN fills, and pending orders fail-closed."""
    client_order_id = str(intent.get("clientOrderId") or "").strip()
    account_login = intent.get("accountLogin")
    server = str(intent.get("server") or "").strip()
    symbol = str(intent.get("symbol") or "").strip().upper()
    direction = str(intent.get("direction") or "").strip().upper()
    requested_volume = intent.get("requestedVolume")
    stop_active_during_send = bool(intent.get("stopActiveDuringSend", False))

    if (
        not client_order_id
        or not _is_positive_int(account_login)
        or not server
        or not symbol
        or direction not in VALID_DIRECTIONS
        or not _is_finite_positive_number(requested_volume)
    ):
        report = {
            "schemaVersion": SCHEMA_VERSION,
            "outcome": "INVALID_INTENT_FAIL_CLOSED",
            "filledVolume": 0.0,
            "remainingVolume": 0.0,
            "matchingOpeningDealCount": 0,
            "ignoredDealCount": 0,
            "matchingPendingOrderCount": 0,
            "uncertainExposure": True,
            "emergencyStopActive": True,
            "blockNewOrders": True,
            "requiresPartialFillReconciliation": False,
            "requiresPostStopFlattenOrReview": True,
            "liveAuthorized": False,
        }
        report["reportSha256"] = _sha256_canonical(report)
        return report

    req_vol = float(requested_volume)
    filled_volume = 0.0
    matching_deal_count = 0
    ignored_deal_count = 0

    for deal in observed_deals:
        if not isinstance(deal, Mapping):
            ignored_deal_count += 1
            continue
        entry = deal.get("entry")
        if type(entry) is not int or entry != 0:
            ignored_deal_count += 1
            continue
        deal_cid = str(deal.get("clientOrderId") or "").strip()
        deal_sym = str(deal.get("symbol") or "").strip().upper()
        deal_dir = str(deal.get("direction") or "").strip().upper()
        deal_srv = str(deal.get("server") or "").strip()
        deal_login = deal.get("accountLogin")
        deal_vol = deal.get("volume")
        if (
            deal_cid != client_order_id
            or deal_sym != symbol
            or deal_dir != direction
            or deal_srv != server
            or not _is_positive_int(deal_login)
            or deal_login != account_login
            or not _is_finite_positive_number(deal_vol)
        ):
            ignored_deal_count += 1
            continue
        filled_volume += float(deal_vol)
        matching_deal_count += 1

    matching_pending = 0
    for order in observed_pending_orders:
        if not isinstance(order, Mapping):
            continue
        order_login = order.get("accountLogin")
        if (
            str(order.get("clientOrderId") or "").strip() == client_order_id
            and str(order.get("symbol") or "").strip().upper() == symbol
            and str(order.get("server") or "").strip() == server
            and _is_positive_int(order_login)
            and order_login == account_login
        ):
            matching_pending += 1

    timed_out = bool(broker_ack.get("timedOut", False))
    disconnected = bool(broker_ack.get("disconnected", False))
    retcode = broker_ack.get("retcode")
    retcode_int = retcode if type(retcode) is int else None

    if filled_volume > req_vol + VOLUME_EPSILON:
        outcome = "UNSAFE_OVERFILL_DETECTED"
        remaining_vol = 0.0
        uncertain_exposure = True
        emergency_stop = True
        block_new_orders = True
        requires_partial = False
        requires_post_stop = True
    elif filled_volume >= req_vol - VOLUME_EPSILON:
        outcome = "CONFIRMED_FULL_FILL"
        remaining_vol = 0.0
        uncertain_exposure = False
        emergency_stop = stop_active_during_send or matching_pending > 0
        block_new_orders = stop_active_during_send or matching_pending > 0
        requires_partial = False
        requires_post_stop = stop_active_during_send or matching_pending > 0
    elif filled_volume > VOLUME_EPSILON:
        outcome = "CONFIRMED_PARTIAL_FILL"
        remaining_vol = round(req_vol - filled_volume, 8)
        uncertain_exposure = timed_out or disconnected
        emergency_stop = stop_active_during_send or timed_out or disconnected
        block_new_orders = True
        requires_partial = True
        requires_post_stop = stop_active_during_send or matching_pending > 0
    else:
        remaining_vol = round(req_vol, 8)
        if (
            not timed_out
            and not disconnected
            and matching_pending == 0
            and retcode_int in REJECTED_NO_EXPOSURE_RETCODES
        ):
            outcome = "CONFIRMED_NO_FILL_REJECTED"
            uncertain_exposure = False
            emergency_stop = stop_active_during_send
            block_new_orders = stop_active_during_send
            requires_partial = False
            requires_post_stop = False
        else:
            outcome = "AMBIGUOUS_EXPOSURE_UNKNOWN"
            uncertain_exposure = True
            emergency_stop = True
            block_new_orders = True
            requires_partial = False
            requires_post_stop = True

    report: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "clientOrderId": client_order_id,
        "symbol": symbol,
        "direction": direction,
        "requestedVolume": round(req_vol, 8),
        "filledVolume": round(filled_volume, 8),
        "remainingVolume": remaining_vol,
        "matchingOpeningDealCount": matching_deal_count,
        "ignoredDealCount": ignored_deal_count,
        "matchingPendingOrderCount": matching_pending,
        "outcome": outcome,
        "uncertainExposure": uncertain_exposure,
        "emergencyStopActive": emergency_stop,
        "blockNewOrders": block_new_orders,
        "requiresPartialFillReconciliation": requires_partial,
        "requiresPostStopFlattenOrReview": requires_post_stop,
        "liveAuthorized": False,
    }
    report["reportSha256"] = _sha256_canonical(report)
    return report
