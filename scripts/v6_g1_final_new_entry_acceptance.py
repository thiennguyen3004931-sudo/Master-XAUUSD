"""G1 P0 read-only final new-entry *claimed-evidence* checklist (#7).

This module NEVER collects trusted Windows ACL/DPAPI/identity evidence, reads
the broker, acquires a cross-process lock, clears a stop latch, or calls MT5.
Every input, including an HMAC secret and timestamp, may be supplied by an
untrusted caller. No positive checklist result authorizes runtime admission.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import math
from typing import Any

TARGET_CALL_SITE_FUNCTION = "_execute_order_serialized"
PURPOSE = "V6_G1_STOP_RELEASE_OFFLINE_INTENT_V1"
NON_AUTHORIZING = {
    "admitted": False,
    "ok": False,
    "liveAuthorized": False,
    "executionEnabled": False,
    "runtimePreSendAccepted": False,
    "orderSendExecuted": False,
    "readOnlyAcceptanceCheck": True,
    "hostIndependentlyVerified": False,
    "brokerReadbackIndependentlyVerified": False,
}


def _positive_int(value: Any) -> bool:
    return type(value) is int and value > 0


def _nonnegative_number(value: Any) -> bool:
    try:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) and value >= 0
    except (TypeError, ValueError, OverflowError):
        return False


def _result(reason: str, *, claims_match: bool = False) -> dict[str, Any]:
    return {
        "ok": False,
        "claimsMatch": claims_match,
        "hostIndependentlyVerified": False,
        "runtimeReleaseAuthorized": False,
        "reason": reason,
    }


def compute_release_hmac(
    *,
    secret_key: bytes,
    account_login: int,
    server: str,
    stop_revision: int,
    operator_id: str,
    approval_reason: str,
    issued_at_utc: int,
    expires_at_utc: int,
) -> str:
    """Hash a purpose-separated offline intent, NOT authorize a latch reset."""
    if not isinstance(secret_key, bytes) or len(secret_key) < 16:
        raise ValueError("Unverified or missing offline signing secret")
    if (not _positive_int(account_login) or not _positive_int(stop_revision)
            or not _positive_int(issued_at_utc) or not _positive_int(expires_at_utc)
            or expires_at_utc <= issued_at_utc or expires_at_utc - issued_at_utc > 300
            or not isinstance(server, str) or not server.strip()
            or not isinstance(operator_id, str) or not operator_id.strip()
            or not isinstance(approval_reason, str) or not approval_reason.strip()):
        raise ValueError("Invalid offline stop release intent")
    msg = json.dumps({
        "purpose": PURPOSE,
        "accountLogin": account_login,
        "server": server.strip().casefold(),
        "stopRevision": stop_revision,
        "operatorId": operator_id.strip(),
        "approvalReason": approval_reason.strip(),
        "issuedAtUtc": issued_at_utc,
        "expiresAtUtc": expires_at_utc,
    }, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hmac.new(secret_key, msg, hashlib.sha256).hexdigest()


def verify_host_trusted_stop_release(
    *,
    host_acl_evidence: dict[str, Any] | None,
    service_identity: dict[str, Any] | None,
    key_custody: dict[str, Any] | None,
    release_auth: dict[str, Any] | None,
    expected_account_login: int,
    expected_server: str,
    expected_stop_revision: int,
    now_utc: int,
    signing_secret: bytes | None,
    max_release_age_sec: int = 300,
) -> dict[str, Any]:
    """Check caller-claimed host fields and offline HMAC, never verify a host."""
    if not isinstance(host_acl_evidence, dict):
        return _result("MISSING_HOST_ACL_EVIDENCE")
    if host_acl_evidence.get("platform") != "Windows" or host_acl_evidence.get("windowsHostAclVerified") is not True:
        return _result("WINDOWS_HOST_ACL_NOT_VERIFIED")
    if host_acl_evidence.get("reparseOrSymlinkDetected") is not False:
        return _result("REPARSE_OR_SYMLINK_DETECTED")
    acl = host_acl_evidence.get("icacls")
    if not isinstance(acl, dict) or acl.get("nonAdminWriteDenied") is not True or acl.get("broadWriteGrants") != []:
        return _result("HOST_ICACLS_BROAD_WRITE_OR_MISSING")
    if not isinstance(service_identity, dict):
        return _result("MISSING_WINDOWS_SERVICE_IDENTITY")
    if not isinstance(service_identity.get("serviceAccount"), str) or not service_identity["serviceAccount"].strip():
        return _result("MISSING_SERVICE_ACCOUNT")
    if service_identity.get("isInteractiveUser") is not False:
        return _result("INTERACTIVE_USER_SESSION_REJECTED")
    if not isinstance(key_custody, dict):
        return _result("MISSING_KEY_CUSTODY_METADATA")
    if key_custody.get("secretValuesExposed") is not False:
        return _result("SECRET_EXPOSURE_DETECTED")
    if key_custody.get("dpapiProtected") is not True:
        return _result("DPAPI_CUSTODY_NOT_VERIFIED")
    if not isinstance(release_auth, dict) or not isinstance(signing_secret, bytes) or len(signing_secret) < 16:
        return _result("MISSING_RELEASE_AUTH_OR_SECRET")
    if not _positive_int(now_utc) or not _positive_int(max_release_age_sec) or max_release_age_sec > 300:
        return _result("INVALID_RELEASE_CLOCK")
    if not _positive_int(expected_account_login) or not _positive_int(expected_stop_revision):
        return _result("INVALID_EXPECTED_ACCOUNT_OR_REVISION")
    issued = release_auth.get("issuedAtUtc")
    expires = release_auth.get("expiresAtUtc")
    if not _positive_int(issued) or not _positive_int(expires):
        return _result("INVALID_RELEASE_ISSUED_OR_EXPIRES_AT")
    if expires <= issued or expires - issued > 300 or now_utc < issued or now_utc > expires or now_utc - issued > max_release_age_sec:
        return _result("RELEASE_AUTH_STALE_FUTURE_OR_WINDOW_INVALID")
    operator = release_auth.get("operatorId")
    reason = release_auth.get("approvalReason")
    if (not isinstance(operator, str) or not operator.strip()
            or not isinstance(reason, str) or not reason.strip()):
        return _result("RELEASE_OPERATOR_OR_REASON_MISSING")
    if (release_auth.get("accountLogin") != expected_account_login
            or not isinstance(expected_server, str)
            or not expected_server.strip()
            or release_auth.get("server") != expected_server):
        return _result("RELEASE_AUTH_ACCOUNT_SERVER_MISMATCH")
    if release_auth.get("stopRevision") != expected_stop_revision:
        return _result("RELEASE_AUTH_REVISION_MISMATCH")
    try:
        expected = compute_release_hmac(
            secret_key=signing_secret,
            account_login=expected_account_login,
            server=expected_server,
            stop_revision=expected_stop_revision,
            operator_id=operator,
            approval_reason=reason,
            issued_at_utc=issued,
            expires_at_utc=expires,
        )
    except (ValueError, TypeError, OverflowError):
        return _result("RELEASE_AUTH_INPUT_INVALID")
    provided = release_auth.get("hmacSha256")
    if not isinstance(provided, str) or len(provided) != 64 or not hmac.compare_digest(provided.lower(), expected):
        return _result("RELEASE_AUTH_HMAC_INVALID")

    # Self-declared ACL/DPAPI, secret and clock are NOT independent proof.
    return _result("CALLER_CLAIMS_AND_HMAC_MATCH_NOT_HOST_ATTESTED", claims_match=True)


def verify_atomic_durable_stop_persistence(persistence: dict[str, Any] | None) -> dict[str, Any]:
    """Inspect caller's claims; does not read/fsync a file or own a lock."""
    if not isinstance(persistence, dict):
        return _result("MISSING_DURABLE_PERSISTENCE_STATE")
    if persistence.get("atomicTempRenameUsed") is not True or persistence.get("fsyncCompleted") is not True:
        return _result("ATOMIC_FSYNC_PERSISTENCE_UNVERIFIED")
    if persistence.get("lockFileHeld") is not True or not _positive_int(persistence.get("lockOwnerPid")):
        return _result("DURABLE_LOCK_FILE_NOT_HELD")
    if not _positive_int(persistence.get("stopRevision")):
        return _result("INVALID_STOP_REVISION")
    if persistence.get("emergencyStopActive") is not False:
        return _result("EMERGENCY_STOP_ACTIVE_FAIL_CLOSED")
    if persistence.get("uncertainEntryLatched") is not False:
        return _result("UNCERTAIN_ENTRY_LATCHED_FAIL_CLOSED")
    return _result("CALLER_PERSISTENCE_CLAIMS_MATCH_NOT_DURABLE_ATTESTATION", claims_match=True)


def verify_readonly_broker_readback(
    *, readback: dict[str, Any] | None, expected_account_login: int,
    expected_server: str, now_utc: int, max_readback_age_sec: int = 5,
) -> dict[str, Any]:
    """Validate an untrusted snapshot shape, NOT query/attest a broker."""
    if not isinstance(readback, dict):
        return _result("MISSING_BROKER_READBACK")
    if (not _positive_int(now_utc) or not _positive_int(max_readback_age_sec)
            or max_readback_age_sec > 30):
        return _result("INVALID_READBACK_CLOCK")
    account = readback.get("accountInfo")
    positions = readback.get("positions")
    orders = readback.get("orders")
    if not isinstance(account, dict) or positions is None or orders is None:
        return _result("BROKER_READBACK_INCOMPLETE_OR_NONE")
    if not isinstance(positions, list) or not isinstance(orders, list):
        return _result("BROKER_READBACK_INVALID_INVENTORY_TYPE")
    if (not _positive_int(expected_account_login)
            or account.get("login") != expected_account_login
            or not isinstance(expected_server, str) or not expected_server.strip()
            or account.get("server") != expected_server):
        return _result("BROKER_READBACK_ACCOUNT_SERVER_MISMATCH")
    timestamp = readback.get("snapshotEpochUtc")
    if not _positive_int(timestamp):
        return _result("BROKER_READBACK_INVALID_TIMESTAMP")
    if not 0 <= now_utc - timestamp <= max_readback_age_sec:
        return _result("BROKER_READBACK_STALE_OR_FUTURE")
    if readback.get("reconciliationClean") is not True:
        return _result("BROKER_READBACK_RECONCILIATION_UNCLEAN")
    for kind, inventory in (("POSITION", positions), ("ORDER", orders)):
        seen = set()
        for item in inventory:
            if not isinstance(item, dict):
                return _result("INVALID_" + kind + "_RECORD")
            ticket = item.get("ticket")
            if not _positive_int(ticket) or ticket in seen:
                return _result("INVALID_OR_DUPLICATE_" + kind + "_TICKET")
            seen.add(ticket)
    return _result("CALLER_BROKER_READBACK_CLAIMS_MATCH_NOT_BROKER_ATTESTED", claims_match=True)


def evaluate_g1_final_new_entry_acceptance(
    *, call_site_function: str, strict_new_order_lock_held: bool,
    expected_account_login: int, expected_server: str, now_utc: int,
    host_acl_evidence: dict[str, Any] | None,
    service_identity: dict[str, Any] | None, key_custody: dict[str, Any] | None,
    release_auth: dict[str, Any] | None, signing_secret: bytes | None,
    persistence_state: dict[str, Any] | None,
    broker_readback: dict[str, Any] | None,
) -> dict[str, Any]:
    """Evaluate mock claims without actual runtime admission or live auth."""
    base = {**NON_AUTHORIZING, "offlineChecksPassed": False}
    if call_site_function != TARGET_CALL_SITE_FUNCTION:
        return {**base, "reason": "INVALID_CALL_SITE_FUNCTION"}
    if strict_new_order_lock_held is not True:
        return {**base, "reason": "STRICT_NEW_ORDER_LOCK_NOT_HELD"}
    if (not _positive_int(expected_account_login)
            or not isinstance(expected_server, str) or not expected_server.strip()
            or not _positive_int(now_utc)):
        return {**base, "reason": "INVALID_EXPECTED_ACCOUNT_SERVER_OR_CLOCK"}

    persistence = verify_atomic_durable_stop_persistence(persistence_state)
    if not persistence["claimsMatch"]:
        return {**base, "reason": persistence["reason"]}
    if (not isinstance(release_auth, dict)
            or persistence_state["stopRevision"] != release_auth.get("stopRevision")):
        return {**base, "reason": "RELEASE_STOP_REVISION_MISMATCH"}
    host = verify_host_trusted_stop_release(
        host_acl_evidence=host_acl_evidence,
        service_identity=service_identity, key_custody=key_custody,
        release_auth=release_auth, expected_account_login=expected_account_login,
        expected_server=expected_server,
        expected_stop_revision=persistence_state["stopRevision"],
        now_utc=now_utc, signing_secret=signing_secret,
    )
    if not host["claimsMatch"]:
        return {**base, "reason": host["reason"]}
    readback = verify_readonly_broker_readback(
        readback=broker_readback, expected_account_login=expected_account_login,
        expected_server=expected_server, now_utc=now_utc,
    )
    if not readback["claimsMatch"]:
        return {**base, "reason": readback["reason"]}
    return {
        **base,
        "offlineChecksPassed": True,
        "hostClaimsMatch": True,
        "persistenceClaimsMatch": True,
        "brokerReadbackClaimsMatch": True,
        "reason": "OFFLINE_CLAIMS_MATCH_BUT_RUNTIME_ADMISSION_UNAVAILABLE",
    }
