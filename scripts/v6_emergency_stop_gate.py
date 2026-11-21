"""Fail-closed Emergency Stop gate & uncertain-entry integration for V6 G1 (#7).

Source-only offline candidate built on `v6_emergency_stop_latch.py` (#88) and
`v6_uncertain_entry_evidence_shadow.py` (#89/#94):
- Strict schema validation: missing/invalid `stopCategory`, `schemaVersion`,
  `triggeredBy`, or `triggeredAtUtc` NEVER masquerades as `OPERATOR_EMERGENCY_STOP`.
- Mandatory atomic compare-and-swap (CAS) under an exclusive cross-process file
  lock (`expected_triggered_at_utc` is required, never optional).
- Recovery flow (`initialize_or_recover_emergency_stop_latch`) ONLY restores a
  well-formed, account-bound ACTIVE stop latch (`emergencyStopActive=True`); it
  NEVER clears or unlocks the latch directly.
- Trust boundary: `operator_authenticated` is a caller-asserted flag in this
  offline library, NOT cryptographic or Windows ACL proof; production release
  remains disabled until owner-approved runtime integration & host ACL verification.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
import time
from pathlib import Path

try:
    from scripts.v6_emergency_stop_latch import _atomic_write_json
    from scripts.v6_uncertain_entry_evidence_shadow import assess_uncertain_entry_evidence
except ImportError:
    from v6_emergency_stop_latch import _atomic_write_json
    from v6_uncertain_entry_evidence_shadow import assess_uncertain_entry_evidence


ACTION_NEW_ORDER = "NEW_ORDER"
ACTION_PROTECTIVE_SL_TP = "PROTECTIVE_SL_TP"
TRUST_BOUNDARY_NOTE = "OFFLINE_CALLER_ASSERTED_NOT_CRYPTOGRAPHIC_RUNTIME_AUTH"
VALID_SCHEMA_VERSION = 1


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


def _clean_text(value, *, max_len: int = 128) -> str:
    return str(value or "").strip()[:max_len]


def _durability_scope() -> str:
    if os.name == "posix":
        return "POSIX_DIR_FSYNC_VERIFIED_RUNTIME_ACCEPTANCE_PENDING"
    return "WINDOWS_HOST_ACL_AND_POWERLOSS_UNVERIFIED"


@contextmanager
def _exclusive_latch_lock(path: Path):
    """Cross-process exclusive lock covering read-validate-write transitions."""
    lock_path = Path(f"{path}.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a+b") as lock_file:
        if os.name == "posix":
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        else:
            import msvcrt

            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)


def _has_active_uncertain_entry(uncertain_entry_state, *, login: int, server: str) -> tuple[bool, str]:
    """Fail-closed check: None or non-dict is treated as unverified/unsafe."""
    if not isinstance(uncertain_entry_state, dict):
        return True, "UNCERTAIN_ENTRY_STATE_UNVERIFIED"
    target = f"{login}|{server}".casefold()
    for raw_key in uncertain_entry_state.keys():
        if str(raw_key or "").strip().casefold() == target:
            return True, "UNCERTAIN_ENTRY_FREEZE_ACTIVE"
    return False, "UNCERTAIN_ENTRY_CLEAR"


def _blocked_latch_result(
    reason: str,
    *,
    category: str,
    account_login=None,
    server: str = "",
    extra: dict | None = None,
) -> dict:
    result = {
        "emergencyStopActive": True,
        "blockNewOrders": True,
        "allowProtectivePositionManagement": True,
        "stopCategory": category,
        "reason": _clean_text(reason),
        "accountLogin": account_login,
        "server": _clean_text(server),
        "liveArmed": False,
        "liveAuthorized": False,
        "runtimeReleaseAllowed": False,
        "trustBoundary": TRUST_BOUNDARY_NOTE,
        "durabilityScope": _durability_scope(),
        "verificationScope": "SOURCE_INTEGRATION_OFFLINE_NOT_LIVE_SAFE",
    }
    if extra:
        result.update(extra)
    return result


def _read_bound_latch_unlocked(path: Path, *, account_login, server: str) -> dict:
    live_login = _positive_int(account_login)
    live_server = _clean_text(server)
    if live_login is None or not live_server:
        return _blocked_latch_result(
            "STOP_LATCH_ACCOUNT_UNVERIFIED",
            category="FAIL_CLOSED_UNVERIFIED",
            account_login=live_login,
            server=live_server,
        )

    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return _blocked_latch_result(
            "STOP_LATCH_MISSING_UNVERIFIED",
            category="FAIL_CLOSED_STARTUP",
            account_login=live_login,
            server=live_server,
        )
    except (OSError, ValueError, UnicodeError):
        return _blocked_latch_result(
            "STOP_LATCH_UNREADABLE_FAIL_CLOSED",
            category="FAIL_CLOSED_CORRUPT",
            account_login=live_login,
            server=live_server,
        )

    if not isinstance(payload, dict):
        return _blocked_latch_result(
            "STOP_LATCH_STATE_UNVERIFIED",
            category="FAIL_CLOSED_CORRUPT",
            account_login=live_login,
            server=live_server,
        )

    saved_login = _positive_int(payload.get("accountLogin"))
    saved_server = _clean_text(payload.get("server"))
    if saved_login != live_login or not saved_server or saved_server.casefold() != live_server.casefold():
        return _blocked_latch_result(
            "STOP_LATCH_ACCOUNT_SERVER_MISMATCH",
            category="FAIL_CLOSED_ACCOUNT_MISMATCH",
            account_login=live_login,
            server=live_server,
            extra={"boundAccountLogin": saved_login, "boundServer": saved_server},
        )

    schema_ver = payload.get("schemaVersion")
    if isinstance(schema_ver, bool) or schema_ver != VALID_SCHEMA_VERSION:
        return _blocked_latch_result(
            "STOP_LATCH_SCHEMA_UNVERIFIED",
            category="FAIL_CLOSED_UNVERIFIED",
            account_login=live_login,
            server=live_server,
        )

    active = payload.get("emergencyStopActive")
    if active is True:
        category = _clean_text(payload.get("stopCategory"))
        triggered_by = _clean_text(payload.get("triggeredBy"))
        triggered_at = _positive_int(payload.get("triggeredAtUtc"))
        reason = _clean_text(payload.get("reason"))
        if category == "OPERATOR_EMERGENCY_STOP" and triggered_by and triggered_at is not None and reason:
            return _blocked_latch_result(
                reason,
                category="OPERATOR_EMERGENCY_STOP",
                account_login=live_login,
                server=live_server,
                extra={"triggeredAtUtc": triggered_at, "triggeredBy": triggered_by},
            )
        return _blocked_latch_result(
            "STOP_LATCH_ACTIVE_METADATA_UNVERIFIED",
            category="FAIL_CLOSED_UNVERIFIED",
            account_login=live_login,
            server=live_server,
        )

    if (
        active is False
        and payload.get("stopCategory") == "AUTHORIZED_CLEAR"
        and payload.get("releaseAuthorized") is True
        and _clean_text(payload.get("releasedBy"))
        and _clean_text(payload.get("releaseReason"))
        and _positive_int(payload.get("releasedAtUtc")) is not None
    ):
        return {
            "emergencyStopActive": False,
            "blockNewOrders": False,
            "allowProtectivePositionManagement": True,
            "stopCategory": "AUTHORIZED_CLEAR",
            "reason": "EMERGENCY_STOP_RELEASED_BY_OPERATOR",
            "accountLogin": live_login,
            "server": live_server,
            "releasedBy": _clean_text(payload.get("releasedBy")),
            "releasedAtUtc": _positive_int(payload.get("releasedAtUtc")),
            "releaseReason": _clean_text(payload.get("releaseReason")),
            "previousStopReason": _clean_text(payload.get("previousStopReason")),
            "liveArmed": False,
            "liveAuthorized": False,
            "runtimeReleaseAllowed": False,
            "trustBoundary": TRUST_BOUNDARY_NOTE,
            "durabilityScope": _durability_scope(),
            "verificationScope": "SOURCE_INTEGRATION_OFFLINE_NOT_LIVE_SAFE",
        }

    return _blocked_latch_result(
        "STOP_LATCH_STATE_UNVERIFIED",
        category="FAIL_CLOSED_UNVERIFIED",
        account_login=live_login,
        server=live_server,
    )


def read_bound_emergency_stop_latch(path: Path, *, account_login, server: str) -> dict:
    """Read durable latch bound to `(account_login, server)`, failing closed on any ambiguity."""
    return _read_bound_latch_unlocked(Path(path), account_login=account_login, server=server)


def persist_operator_emergency_stop(
    path: Path,
    *,
    account_login: int,
    server: str,
    operator_id: str,
    reason: str = "OPERATOR_EMERGENCY_STOP",
    now_utc: float | None = None,
) -> dict:
    """Atomically persist an explicit operator-triggered Emergency Stop bound to account+server."""
    login = _positive_int(account_login)
    srv = _clean_text(server)
    op_id = _clean_text(operator_id)
    ts = _positive_int(int(time.time() if now_utc is None else now_utc))
    if login is None or not srv or not op_id or ts is None:
        raise ValueError("account_login, server, operator_id, and positive timestamp are required")

    record = {
        "schemaVersion": VALID_SCHEMA_VERSION,
        "emergencyStopActive": True,
        "blockNewOrders": True,
        "allowProtectivePositionManagement": True,
        "stopCategory": "OPERATOR_EMERGENCY_STOP",
        "reason": _clean_text(reason or "OPERATOR_EMERGENCY_STOP"),
        "accountLogin": login,
        "server": srv,
        "triggeredBy": op_id,
        "triggeredAtUtc": ts,
        "releaseAuthorized": False,
    }
    target = Path(path)
    with _exclusive_latch_lock(target):
        _atomic_write_json(target, record)
        return _read_bound_latch_unlocked(target, account_login=login, server=srv)


def initialize_or_recover_emergency_stop_latch(
    path: Path,
    *,
    account_login: int,
    server: str,
    operator_authenticated: bool = False,
    operator_id: str = "",
    recovery_reason: str = "",
    recovery_evidence_verified: bool = False,
    now_utc: float | None = None,
) -> dict:
    """Recover missing/corrupt/mismatched state into an ACTIVE, well-formed stop latch."""
    login = _positive_int(account_login)
    srv = _clean_text(server)
    op_id = _clean_text(operator_id)
    reason = _clean_text(recovery_reason)
    ts = _positive_int(int(time.time() if now_utc is None else now_utc))
    target = Path(path)

    with _exclusive_latch_lock(target):
        current = _read_bound_latch_unlocked(target, account_login=login, server=srv)
        if login is None or not srv or ts is None:
            return {**current, "recoveryDenied": True, "recoveryDeniedReason": "ACCOUNT_UNVERIFIED"}
        if operator_authenticated is not True or not op_id or not reason:
            return {**current, "recoveryDenied": True, "recoveryDeniedReason": "OPERATOR_AUTH_REQUIRED"}
        if recovery_evidence_verified is not True:
            return {**current, "recoveryDenied": True, "recoveryDeniedReason": "RECOVERY_EVIDENCE_REQUIRED"}
        if current["stopCategory"] not in (
            "FAIL_CLOSED_STARTUP",
            "FAIL_CLOSED_CORRUPT",
            "FAIL_CLOSED_ACCOUNT_MISMATCH",
            "FAIL_CLOSED_UNVERIFIED",
        ):
            return {**current, "recoveryDenied": True, "recoveryDeniedReason": "RECOVERY_NOT_REQUIRED"}

        record = {
            "schemaVersion": VALID_SCHEMA_VERSION,
            "emergencyStopActive": True,
            "blockNewOrders": True,
            "allowProtectivePositionManagement": True,
            "stopCategory": "OPERATOR_EMERGENCY_STOP",
            "reason": _clean_text(f"RECOVERED_FAIL_CLOSED:{reason}"),
            "accountLogin": login,
            "server": srv,
            "triggeredBy": op_id,
            "triggeredAtUtc": ts,
            "releaseAuthorized": False,
        }
        _atomic_write_json(target, record)
        result = _read_bound_latch_unlocked(target, account_login=login, server=srv)
        result["recoveryDenied"] = False
        return result


def authorize_emergency_stop_release(
    path: Path,
    *,
    account_login: int,
    server: str,
    operator_authenticated: bool = False,
    operator_id: str = "",
    approval_reason: str = "",
    uncertain_entry_state: dict | None = None,
    expected_triggered_at_utc: int | None = None,
    now_utc: float | None = None,
) -> dict:
    """Atomically release a well-formed, active OPERATOR_EMERGENCY_STOP under exclusive lock."""
    login = _positive_int(account_login)
    srv = _clean_text(server)
    op_id = _clean_text(operator_id)
    reason = _clean_text(approval_reason)
    exp_ts = _positive_int(expected_triggered_at_utc)
    now_ts = _positive_int(int(time.time() if now_utc is None else now_utc))
    target = Path(path)

    with _exclusive_latch_lock(target):
        current = _read_bound_latch_unlocked(target, account_login=login, server=srv)
        if login is None or not srv or now_ts is None:
            return {**current, "releaseDenied": True, "releaseDeniedReason": "ACCOUNT_UNVERIFIED"}
        if operator_authenticated is not True or not op_id or not reason:
            return {**current, "releaseDenied": True, "releaseDeniedReason": "OPERATOR_AUTH_REQUIRED"}
        if exp_ts is None:
            return {**current, "releaseDenied": True, "releaseDeniedReason": "EXPECTED_VERSION_REQUIRED"}
        if current["stopCategory"] != "OPERATOR_EMERGENCY_STOP" or current["emergencyStopActive"] is not True:
            return {**current, "releaseDenied": True, "releaseDeniedReason": "REQUIRES_ACTIVE_OPERATOR_STOP"}
        if current.get("triggeredAtUtc") != exp_ts:
            return {**current, "releaseDenied": True, "releaseDeniedReason": "STALE_LATCH_VERSION_MISMATCH"}

        frozen, freeze_reason = _has_active_uncertain_entry(uncertain_entry_state, login=login, server=srv)
        if frozen:
            return {**current, "releaseDenied": True, "releaseDeniedReason": freeze_reason}

        record = {
            "schemaVersion": VALID_SCHEMA_VERSION,
            "emergencyStopActive": False,
            "blockNewOrders": False,
            "allowProtectivePositionManagement": True,
            "stopCategory": "AUTHORIZED_CLEAR",
            "accountLogin": login,
            "server": srv,
            "releaseAuthorized": True,
            "releasedBy": op_id,
            "releaseReason": reason,
            "releasedAtUtc": now_ts,
            "previousStopReason": current.get("reason") or "OPERATOR_EMERGENCY_STOP",
        }
        _atomic_write_json(target, record)
        result = _read_bound_latch_unlocked(target, account_login=login, server=srv)
        result["releaseDenied"] = False
        return result


def enrich_uncertain_entry_fill_evidence(
    *,
    intent: dict | None,
    snapshot_login,
    snapshot_server: str,
    broker_positions,
    broker_pending_orders,
    broker_deals,
    bot_magic: int = 270715,
) -> dict:
    """Enrich uncertain-entry fillEvidence using #89/#94 without ever clearing the freeze."""
    return assess_uncertain_entry_evidence(
        intent=intent,
        snapshot_login=snapshot_login,
        snapshot_server=snapshot_server,
        broker_positions=broker_positions,
        broker_pending_orders=broker_pending_orders,
        broker_deals=broker_deals,
        bot_magic=bot_magic,
    )


def evaluate_new_order_gate(
    *,
    action_kind: str,
    latch_path: Path,
    account_login,
    server: str,
    uncertain_entry_state: dict | None = None,
    live_armed: bool = False,
) -> dict:
    """Latch-only offline candidate gate separating NEW_ORDER from PROTECTIVE_SL_TP."""
    kind = _clean_text(action_kind).upper()
    if kind == ACTION_PROTECTIVE_SL_TP:
        return {
            "allowed": True,
            "blockedByStopLatch": False,
            "actionKind": ACTION_PROTECTIVE_SL_TP,
            "reason": "NOT_BLOCKED_BY_STOP_LATCH_REQUIRES_INDEPENDENT_SL_VERIFICATION",
            "allowProtectivePositionManagement": True,
            "gateScope": "LATCH_ONLY_OFFLINE_CANDIDATE_NOT_FINAL_AUTH",
            "liveArmed": False,
            "liveAuthorized": False,
        }

    if kind != ACTION_NEW_ORDER:
        return {
            "allowed": False,
            "blockedByStopLatch": True,
            "actionKind": kind or "UNKNOWN",
            "reason": "BLOCKED_UNKNOWN_ACTION_KIND",
            "allowProtectivePositionManagement": True,
            "gateScope": "LATCH_ONLY_OFFLINE_CANDIDATE_NOT_FINAL_AUTH",
            "liveArmed": False,
            "liveAuthorized": False,
        }

    latch = read_bound_emergency_stop_latch(latch_path, account_login=account_login, server=server)
    if latch["emergencyStopActive"] or latch["blockNewOrders"]:
        return {
            "allowed": False,
            "blockedByStopLatch": True,
            "actionKind": ACTION_NEW_ORDER,
            "reason": latch["reason"],
            "stopCategory": latch["stopCategory"],
            "allowProtectivePositionManagement": True,
            "gateScope": "LATCH_ONLY_OFFLINE_CANDIDATE_NOT_FINAL_AUTH",
            "liveArmed": False,
            "liveAuthorized": False,
        }

    login = _positive_int(account_login)
    srv = _clean_text(server)
    if login is None or not srv:
        return {
            "allowed": False,
            "blockedByStopLatch": True,
            "actionKind": ACTION_NEW_ORDER,
            "reason": "STOP_LATCH_ACCOUNT_UNVERIFIED",
            "allowProtectivePositionManagement": True,
            "gateScope": "LATCH_ONLY_OFFLINE_CANDIDATE_NOT_FINAL_AUTH",
            "liveArmed": False,
            "liveAuthorized": False,
        }

    frozen, freeze_reason = _has_active_uncertain_entry(uncertain_entry_state, login=login, server=srv)
    if frozen:
        mapped_reason = (
            "BLOCKED_ENTRY_STATE_UNAVAILABLE"
            if freeze_reason == "UNCERTAIN_ENTRY_STATE_UNVERIFIED"
            else "BLOCKED_UNCERTAIN_PREVIOUS_ENTRY"
        )
        return {
            "allowed": False,
            "blockedByStopLatch": False,
            "actionKind": ACTION_NEW_ORDER,
            "reason": mapped_reason,
            "allowProtectivePositionManagement": True,
            "gateScope": "LATCH_ONLY_OFFLINE_CANDIDATE_NOT_FINAL_AUTH",
            "liveArmed": False,
            "liveAuthorized": False,
        }

    if live_armed is not True:
        return {
            "allowed": False,
            "blockedByStopLatch": False,
            "actionKind": ACTION_NEW_ORDER,
            "reason": "BLOCKED_LIVE_NOT_ARMED",
            "allowProtectivePositionManagement": True,
            "gateScope": "LATCH_ONLY_OFFLINE_CANDIDATE_NOT_FINAL_AUTH",
            "liveArmed": False,
            "liveAuthorized": False,
        }

    return {
        "allowed": True,
        "allowedByStopLatchOnly": True,
        "blockedByStopLatch": False,
        "actionKind": ACTION_NEW_ORDER,
        "reason": "LATCH_AND_ENTRY_STATE_CLEAR_OFFLINE_CANDIDATE_ONLY",
        "stopCategory": latch["stopCategory"],
        "allowProtectivePositionManagement": True,
        "gateScope": "LATCH_ONLY_OFFLINE_CANDIDATE_NOT_FINAL_AUTH",
        "liveArmed": True,
        "liveAuthorized": False,
    }
