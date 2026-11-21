"""Source-only final new-order admission contract & host ACL/reset design for V6 G1/G4 (#7).

Maps the complete pre-`mt5.order_send` admission boundary of
`scripts/mt5-direct-probe.py` (`execute_order` -> `_strict_new_order_lock` ->
`_execute_order_serialized`) without wiring into live execution
(`liveExecutionWired=False`, `liveAuthorized=False`).
"""
from __future__ import annotations

import hashlib
import hmac
import json
from math import isfinite
from pathlib import Path

try:
    from scripts.v6_emergency_stop_gate import (
        ACTION_NEW_ORDER,
        ACTION_PROTECTIVE_SL_TP,
        read_bound_emergency_stop_latch,
        evaluate_new_order_gate,
    )
except ImportError:
    from v6_emergency_stop_gate import (
        ACTION_NEW_ORDER,
        ACTION_PROTECTIVE_SL_TP,
        read_bound_emergency_stop_latch,
        evaluate_new_order_gate,
    )


ADMISSION_SCOPE_NOTE = "SOURCE_ONLY_ADMISSION_CONTRACT_RUNTIME_ACCEPTANCE_REQUIRED"


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


def assess_caller_supplied_acl_claims(acl_attestation: dict | None) -> dict:
    """Only check untrusted ACL claims; NEVER attest Windows host permissions."""
    if not isinstance(acl_attestation, dict):
        return {"ok": False, "reason": "WINDOWS_HOST_ACL_UNVERIFIED"}

    owner = str(acl_attestation.get("ownerPrincipal") or "").strip()
    if (
        acl_attestation.get("aclVerified") is not True
        or not owner
        or acl_attestation.get("nonAdminWriteDenied") is not True
        or acl_attestation.get("worldReadable") is not False
        or acl_attestation.get("storageDirExists") is not True
    ):
        return {"ok": False, "reason": "WINDOWS_HOST_ACL_UNVERIFIED"}

    return {
        "ok": True,
        "reason": "WINDOWS_ACL_CHECKLIST_MATCHED_UNATTESTED",
        "ownerPrincipal": owner,
        "hostAclIndependentlyVerified": False,
        "evidenceSource": "CALLER_SUPPLIED_NOT_WINDOWS_HOST_ATTESTED",
    }


def compute_operator_reset_hmac(
    *,
    operator_secret: str,
    account_login: int,
    server: str,
    stop_revision: str,
    operator_id: str,
    approval_reason: str,
    issued_at_utc: int,
    expires_at_utc: int,
) -> str:
    """Sign a purpose-separated, short-lived OFFLINE reset-intent message."""
    canonical = json.dumps({
        "purpose": "V6_EMERGENCY_STOP_RELEASE_OFFLINE_V1",
        "accountLogin": int(account_login),
        "server": server.strip().casefold(),
        "stopRevision": stop_revision.strip(),
        "operatorId": operator_id.strip(),
        "approvalReason": approval_reason.strip(),
        "issuedAtUtc": int(issued_at_utc),
        "expiresAtUtc": int(expires_at_utc),
    }, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hmac.new(operator_secret.encode("utf-8"), canonical, hashlib.sha256).hexdigest()


def verify_operator_reset_token_offline(
    *,
    latch_path: Path,
    account_login: int,
    server: str,
    operator_id: str,
    approval_reason: str,
    expected_stop_revision: str,
    issued_at_utc: int,
    expires_at_utc: int,
    provided_hmac: str,
    operator_secret: str,
    uncertain_entry_state: dict | None,
    now_utc: float,
) -> dict:
    """Validate an offline token, NEVER mutate the latch or authorize LIVE."""
    login = _positive_int(account_login)
    issued_ts = _positive_int(issued_at_utc)
    exp_ts = _positive_int(expires_at_utc)
    now_ts = _positive_int(int(now_utc) if isinstance(now_utc, (int, float)) and not isinstance(now_utc, bool) and isfinite(now_utc) else None)
    srv = str(server or "").strip()
    op_id = str(operator_id or "").strip()
    rev = str(expected_stop_revision or "").strip()
    reason = str(approval_reason or "").strip()
    secret = str(operator_secret or "")
    token = str(provided_hmac or "").strip()

    def deny(code: str) -> dict:
        return {
            "ok": False, "tokenValidOffline": False,
            "releaseDenied": True, "releaseDeniedReason": code,
            "releaseApplied": False, "operatorIdentityVerifiedByHost": False,
            "liveExecutionWired": False, "liveAuthorized": False,
        }

    if login is None or not srv or not op_id or not rev or not reason or issued_ts is None or exp_ts is None or now_ts is None:
        return deny("RESET_TOKEN_PARAMETERS_INVALID")
    if len(secret) < 16 or len(token) != 64:
        return deny("RESET_AUTH_SECRET_OR_TOKEN_INVALID")
    if exp_ts <= issued_ts or exp_ts - issued_ts > 300:
        return deny("RESET_TOKEN_WINDOW_INVALID")
    if now_ts < issued_ts:
        return deny("RESET_TOKEN_NOT_YET_VALID")
    if now_ts > exp_ts:
        return deny("RESET_TOKEN_EXPIRED")

    expected_hmac = compute_operator_reset_hmac(
        operator_secret=secret, account_login=login, server=srv,
        stop_revision=rev, operator_id=op_id, approval_reason=reason,
        issued_at_utc=issued_ts, expires_at_utc=exp_ts,
    )
    if not hmac.compare_digest(token.lower(), expected_hmac.lower()):
        return deny("RESET_TOKEN_HMAC_MISMATCH")

    # The secret, time, and claimed broker state come from the caller.
    # This result MUST NOT be used to clear an actual emergency stop.
    latch = read_bound_emergency_stop_latch(latch_path, account_login=login, server=srv)
    if latch.get("emergencyStopActive") is not True or latch.get("stopCategory") != "OPERATOR_EMERGENCY_STOP":
        return deny("RESET_ACTIVE_BOUND_LATCH_REQUIRED")
    if latch.get("stopRevision") != rev:
        return deny("RESET_STALE_STOP_REVISION")
    if not isinstance(uncertain_entry_state, dict) or uncertain_entry_state:
        return deny("RESET_BROKER_ENTRY_EVIDENCE_UNVERIFIED")
    return {
        "ok": True, "tokenValidOffline": True,
        "releaseDenied": True,
        "releaseDeniedReason": "RESET_RUNTIME_AUTHORIZATION_UNAVAILABLE",
        "releaseApplied": False,
        "operatorIdentityVerifiedByHost": False,
        "secretProvenance": "CALLER_SUPPLIED_NOT_HOST_VERIFIED",
        "clockProvenance": "CALLER_SUPPLIED_NOT_HOST_VERIFIED",
        "liveExecutionWired": False, "liveAuthorized": False,
    }


def evaluate_final_new_order_admission(
    *,
    action_kind: str,
    latch_path: Path,
    account_login,
    server: str,
    acl_attestation: dict | None,
    uncertain_entry_state: dict | None,
    daily_loss_check: dict | None,
    last_moment_margin_check: dict | None,
    live_armed: bool = False,
) -> dict:
    """Source-only final new-order admission contract mapped to mt5-direct-probe.py."""
    kind = str(action_kind or "").strip().upper()
    if kind == ACTION_PROTECTIVE_SL_TP:
        return {
            "admitted": False,
            "offlineChecksPassed": False,
            "latchDoesNotBlockProtectiveManagement": True,
            "actionKind": ACTION_PROTECTIVE_SL_TP,
            "blockedByStopLatch": False,
            "reason": "PROTECTIVE_SL_TP_UNAFFECTED_REQUIRES_POSITION_OWNERSHIP_CHECK",
            "liveExecutionWired": False,
            "liveAuthorized": False,
            "scope": ADMISSION_SCOPE_NOTE,
        }

    if kind != ACTION_NEW_ORDER:
        return {
            "admitted": False,
            "actionKind": kind or "UNKNOWN",
            "reason": "BLOCKED_UNKNOWN_ACTION_KIND",
            "liveExecutionWired": False,
            "liveAuthorized": False,
            "scope": ADMISSION_SCOPE_NOTE,
        }

    acl = assess_caller_supplied_acl_claims(acl_attestation)
    if not acl["ok"]:
        return {
            "admitted": False,
            "actionKind": ACTION_NEW_ORDER,
            "reason": acl["reason"],
            "liveExecutionWired": False,
            "liveAuthorized": False,
            "scope": ADMISSION_SCOPE_NOTE,
        }

    gate = evaluate_new_order_gate(
        action_kind=ACTION_NEW_ORDER,
        latch_path=latch_path,
        account_login=account_login,
        server=server,
        uncertain_entry_state=uncertain_entry_state,
        live_armed=live_armed,
    )
    if not gate.get("allowed"):
        return {
            "admitted": False,
            "actionKind": ACTION_NEW_ORDER,
            "reason": str(gate.get("reason") or "BLOCKED_STOP_OR_ENTRY_GATE"),
            "liveExecutionWired": False,
            "liveAuthorized": False,
            "scope": ADMISSION_SCOPE_NOTE,
        }

    if (
        not isinstance(daily_loss_check, dict)
        or daily_loss_check.get("ok") is not True
        or daily_loss_check.get("dailyLimitBreached") is not False
        or daily_loss_check.get("wouldExceedWithNewOrder") is not False
    ):
        return {
            "admitted": False,
            "actionKind": ACTION_NEW_ORDER,
            "reason": "BLOCKED_DAILY_LOSS_OR_HISTORY_UNVERIFIED",
            "liveExecutionWired": False,
            "liveAuthorized": False,
            "scope": ADMISSION_SCOPE_NOTE,
        }

    if (
        not isinstance(last_moment_margin_check, dict)
        or last_moment_margin_check.get("ok") is not True
        or last_moment_margin_check.get("freeMarginOk") is not True
    ):
        return {
            "admitted": False,
            "actionKind": ACTION_NEW_ORDER,
            "reason": "BLOCKED_LAST_MOMENT_MARGIN_UNVERIFIED",
            "liveExecutionWired": False,
            "liveAuthorized": False,
            "scope": ADMISSION_SCOPE_NOTE,
        }

    return {
        "admitted": False,
        "offlineChecksPassed": True,
        "actionKind": ACTION_NEW_ORDER,
        "reason": "OFFLINE_CHECKLIST_PASSED_NOT_RUNTIME_AUTHORIZED",
        "liveExecutionWired": False,
        "liveAuthorized": False,
        "scope": ADMISSION_SCOPE_NOTE,
    }
