"""G1 P0 final new-entry Emergency Stop source+host acceptance contract (#7).

Strictly NO-ORDER / OFFLINE / READ-ONLY:
- NEVER imports MetaTrader5, NEVER calls `order_send`, NEVER mutates ARM/runtime.
- Evaluates the exact admission boundary immediately before `mt5.order_send(req)`
  inside `_execute_order_serialized` (~line 2508) under `_strict_new_order_lock`.
- Fails closed on any missing or unattested host/service/custody/persistence/readback
  evidence, without trusting bare caller booleans.
"""
from __future__ import annotations

import hashlib
import hmac
import math
from typing import Any

TARGET_CALL_SITE_FUNCTION = "_execute_order_serialized"


def _is_pos_int(val: Any) -> bool:
    return isinstance(val, int) and not isinstance(val, bool) and val > 0


def _is_finite_nonneg(val: Any) -> bool:
    return isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(val) and val >= 0.0


def compute_release_hmac(
    *,
    secret_key: bytes,
    account_login: int,
    server: str,
    stop_revision: int,
    issued_at_utc: int,
) -> str:
    """Compute canonical HMAC-SHA256 digest for trusted stop-release authorization."""
    msg = f"{int(account_login)}|{str(server).strip()}|{int(stop_revision)}|{int(issued_at_utc)}".encode("utf-8")
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
    """Verify Windows host ACLs, service identity, key custody, and HMAC release auth."""
    if not isinstance(host_acl_evidence, dict):
        return {"ok": False, "reason": "MISSING_HOST_ACL_EVIDENCE"}
    if host_acl_evidence.get("platform") != "Windows" or host_acl_evidence.get("windowsHostAclVerified") is not True:
        return {"ok": False, "reason": "WINDOWS_HOST_ACL_NOT_VERIFIED"}
    if host_acl_evidence.get("reparseOrSymlinkDetected") is not False:
        return {"ok": False, "reason": "REPARSE_OR_SYMLINK_DETECTED"}
    icacls = host_acl_evidence.get("icacls")
    if not isinstance(icacls, dict) or icacls.get("nonAdminWriteDenied") is not True or icacls.get("broadWriteGrants") != []:
        return {"ok": False, "reason": "HOST_ICACLS_BROAD_WRITE_OR_MISSING"}

    if not isinstance(service_identity, dict):
        return {"ok": False, "reason": "MISSING_WINDOWS_SERVICE_IDENTITY"}
    if not str(service_identity.get("serviceAccount") or "").strip():
        return {"ok": False, "reason": "MISSING_SERVICE_ACCOUNT"}
    if service_identity.get("isInteractiveUser") is not False:
        return {"ok": False, "reason": "INTERACTIVE_USER_SESSION_REJECTED"}

    if not isinstance(key_custody, dict):
        return {"ok": False, "reason": "MISSING_KEY_CUSTODY_METADATA"}
    if key_custody.get("secretValuesExposed") is not False:
        return {"ok": False, "reason": "SECRET_EXPOSURE_DETECTED"}
    if key_custody.get("dpapiProtected") is not True:
        return {"ok": False, "reason": "DPAPI_CUSTODY_NOT_VERIFIED"}

    if not isinstance(release_auth, dict) or not signing_secret:
        return {"ok": False, "reason": "MISSING_RELEASE_AUTH_OR_SECRET"}
    if not _is_pos_int(max_release_age_sec) or not _is_pos_int(now_utc):
        return {"ok": False, "reason": "INVALID_RELEASE_CLOCK"}

    issued_at = release_auth.get("issuedAtUtc")
    if not _is_pos_int(issued_at):
        return {"ok": False, "reason": "INVALID_RELEASE_ISSUED_AT"}
    age = int(now_utc) - int(issued_at)
    if age < 0 or age > int(max_release_age_sec):
        return {"ok": False, "reason": "RELEASE_AUTH_STALE_OR_FUTURE"}

    if release_auth.get("accountLogin") != expected_account_login or str(release_auth.get("server") or "").strip() != str(expected_server).strip():
        return {"ok": False, "reason": "RELEASE_AUTH_ACCOUNT_SERVER_MISMATCH"}
    if release_auth.get("stopRevision") != expected_stop_revision:
        return {"ok": False, "reason": "RELEASE_AUTH_REVISION_MISMATCH"}

    expected_sig = compute_release_hmac(
        secret_key=signing_secret,
        account_login=expected_account_login,
        server=expected_server,
        stop_revision=expected_stop_revision,
        issued_at_utc=int(issued_at),
    )
    provided_sig = str(release_auth.get("hmacSha256") or "")
    if not provided_sig or not hmac.compare_digest(provided_sig, expected_sig):
        return {"ok": False, "reason": "RELEASE_AUTH_HMAC_INVALID"}

    return {"ok": True, "reason": "HOST_TRUSTED_STOP_RELEASE_VERIFIED"}


def verify_atomic_durable_stop_persistence(persistence: dict[str, Any] | None) -> dict[str, Any]:
    """Verify atomic write+fsync durable stop state and cleared emergency/uncertain latches."""
    if not isinstance(persistence, dict):
        return {"ok": False, "reason": "MISSING_DURABLE_PERSISTENCE_STATE"}
    if persistence.get("atomicTempRenameUsed") is not True or persistence.get("fsyncCompleted") is not True:
        return {"ok": False, "reason": "ATOMIC_FSYNC_PERSISTENCE_UNVERIFIED"}
    if persistence.get("lockFileHeld") is not True or not _is_pos_int(persistence.get("lockOwnerPid")):
        return {"ok": False, "reason": "DURABLE_LOCK_FILE_NOT_HELD"}
    if not _is_pos_int(persistence.get("stopRevision")):
        return {"ok": False, "reason": "INVALID_STOP_REVISION"}
    if persistence.get("emergencyStopActive") is not False:
        return {"ok": False, "reason": "EMERGENCY_STOP_ACTIVE_FAIL_CLOSED"}
    if persistence.get("uncertainEntryLatched") is not False:
        return {"ok": False, "reason": "UNCERTAIN_ENTRY_LATCHED_FAIL_CLOSED"}
    return {"ok": True, "reason": "ATOMIC_DURABLE_STOP_PERSISTENCE_OK"}


def verify_readonly_broker_readback(
    *,
    readback: dict[str, Any] | None,
    expected_account_login: int,
    expected_server: str,
    now_utc: int,
    max_readback_age_sec: int = 5,
) -> dict[str, Any]:
    """Verify read-only broker readback (account, positions, orders, reconciliation)."""
    if not isinstance(readback, dict):
        return {"ok": False, "reason": "MISSING_BROKER_READBACK"}
    if not _is_pos_int(max_readback_age_sec) or not _is_pos_int(now_utc):
        return {"ok": False, "reason": "INVALID_READBACK_CLOCK"}

    acct = readback.get("accountInfo")
    positions = readback.get("positions")
    orders = readback.get("orders")
    if not isinstance(acct, dict) or positions is None or orders is None:
        return {"ok": False, "reason": "BROKER_READBACK_INCOMPLETE_OR_NONE"}
    if not isinstance(positions, list) or not isinstance(orders, list):
        return {"ok": False, "reason": "BROKER_READBACK_INVALID_INVENTORY_TYPE"}
    if acct.get("login") != expected_account_login or str(acct.get("server") or "").strip() != str(expected_server).strip():
        return {"ok": False, "reason": "BROKER_READBACK_ACCOUNT_SERVER_MISMATCH"}

    snap_utc = readback.get("snapshotEpochUtc")
    if not _is_pos_int(snap_utc):
        return {"ok": False, "reason": "BROKER_READBACK_INVALID_TIMESTAMP"}
    age = int(now_utc) - int(snap_utc)
    if age < 0 or age > int(max_readback_age_sec):
        return {"ok": False, "reason": "BROKER_READBACK_STALE_OR_FUTURE"}

    if readback.get("reconciliationClean") is not True:
        return {"ok": False, "reason": "BROKER_READBACK_RECONCILIATION_UNCLEAN"}

    return {"ok": True, "reason": "READONLY_BROKER_READBACK_VERIFIED"}


def evaluate_g1_final_new_entry_acceptance(
    *,
    call_site_function: str,
    strict_new_order_lock_held: bool,
    expected_account_login: int,
    expected_server: str,
    now_utc: int,
    host_acl_evidence: dict[str, Any] | None,
    service_identity: dict[str, Any] | None,
    key_custody: dict[str, Any] | None,
    release_auth: dict[str, Any] | None,
    signing_secret: bytes | None,
    persistence_state: dict[str, Any] | None,
    broker_readback: dict[str, Any] | None,
) -> dict[str, Any]:
    """Evaluate complete G1 P0 source+host acceptance contract (strictly NO-ORDER / OFFLINE)."""
    envelope = {
        "orderSendExecuted": False,
        "liveAuthorized": False,
        "readOnlyAcceptanceCheck": True,
    }
    if call_site_function != TARGET_CALL_SITE_FUNCTION:
        return {**envelope, "admitted": False, "reason": "INVALID_CALL_SITE_FUNCTION"}
    if strict_new_order_lock_held is not True:
        return {**envelope, "admitted": False, "reason": "STRICT_NEW_ORDER_LOCK_NOT_HELD"}
    if not _is_pos_int(expected_account_login) or not str(expected_server or "").strip():
        return {**envelope, "admitted": False, "reason": "INVALID_EXPECTED_ACCOUNT_OR_SERVER"}

    pers_res = verify_atomic_durable_stop_persistence(persistence_state)
    if not pers_res["ok"]:
        return {**envelope, "admitted": False, "reason": pers_res["reason"]}

    host_res = verify_host_trusted_stop_release(
        host_acl_evidence=host_acl_evidence,
        service_identity=service_identity,
        key_custody=key_custody,
        release_auth=release_auth,
        expected_account_login=expected_account_login,
        expected_server=expected_server,
        expected_stop_revision=int(persistence_state["stopRevision"]),
        now_utc=now_utc,
        signing_secret=signing_secret,
    )
    if not host_res["ok"]:
        return {**envelope, "admitted": False, "reason": host_res["reason"]}

    rb_res = verify_readonly_broker_readback(
        readback=broker_readback,
        expected_account_login=expected_account_login,
        expected_server=expected_server,
        now_utc=now_utc,
    )
    if not rb_res["ok"]:
        return {**envelope, "admitted": False, "reason": rb_res["reason"]}

    return {
        **envelope,
        "admitted": True,
        "reason": "G1_FINAL_NEW_ENTRY_SOURCE_AND_HOST_CONTRACT_SATISFIED",
    }
