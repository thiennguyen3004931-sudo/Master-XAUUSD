"""Fail-closed Emergency Stop gate & uncertain-entry integration for V6 G1 (#7).

Source-only offline candidate built on `v6_emergency_stop_latch.py` (#88) and
`v6_uncertain_entry_evidence_shadow.py` (#89/#94):
- Binds durable latch state to `(accountLogin, server)` and operator identity.
- Distinguishes explicit operator Emergency Stop from fail-closed startup/corrupt states.
- Denies `authorize_emergency_stop_release` unless an active, well-formed,
  account-bound `OPERATOR_EMERGENCY_STOP` already exists, `uncertain_entry_state`
  is explicitly verified empty for `(accountLogin, server)` (never defaulted to
  safe), and caller-supplied approval + CAS timestamp match.
- Provides a separate `initialize_or_recover_emergency_stop_latch` path for
  missing/corrupt/mismatched recovery with explicit `recovery_evidence_verified`.
- Trust boundary: `operator_authenticated` is a caller-asserted flag in this
  offline library, NOT cryptographic or Windows ACL proof; production release
  remains disabled until owner-approved runtime integration & host ACL verification.
- `evaluate_new_order_gate` is strictly a *latch-only offline candidate* check
  (`liveAuthorized` is always `False`; `PROTECTIVE_SL_TP` means *not blocked by
  stop latch*, not bypassing independent position/SL verification).
"""
from __future__ import annotations

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


def _positive_login(value) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        login = int(value)
        if login <= 0 or str(login) != str(value).strip():
            return None
        return login
    except (TypeError, ValueError, OverflowError):
        return None


def _clean_text(value, *, max_len: int = 128) -> str:
    return str(value or "").strip()[:max_len]


def _durability_scope() -> str:
    if os.name == "posix":
        return "POSIX_DIR_FSYNC_VERIFIED_RUNTIME_ACCEPTANCE_PENDING"
    return "WINDOWS_HOST_ACL_AND_POWERLOSS_UNVERIFIED"


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


def read_bound_emergency_stop_latch(path: Path, *, account_login, server: str) -> dict:
    """Read durable latch bound to `(account_login, server)`, failing closed on any ambiguity."""
    live_login = _positive_login(account_login)
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

    saved_login = _positive_login(payload.get("accountLogin"))
    saved_server = _clean_text(payload.get("server"))
    if saved_login != live_login or not saved_server or saved_server.casefold() != live_server.casefold():
        return _blocked_latch_result(
            "STOP_LATCH_ACCOUNT_SERVER_MISMATCH",
            category="FAIL_CLOSED_ACCOUNT_MISMATCH",
            account_login=live_login,
            server=live_server,
            extra={"boundAccountLogin": saved_login, "boundServer": saved_server},
        )

    active = payload.get("emergencyStopActive")
    if active is True:
        category = _clean_text(payload.get("stopCategory")) or "OPERATOR_EMERGENCY_STOP"
        if category not in (
            "OPERATOR_EMERGENCY_STOP",
            "FAIL_CLOSED_STARTUP",
            "FAIL_CLOSED_CORRUPT",
            "FAIL_CLOSED_UNVERIFIED",
        ):
            category = "OPERATOR_EMERGENCY_STOP"
        return _blocked_latch_result(
            _clean_text(payload.get("reason")) or "EMERGENCY_STOP_ACTIVE",
            category=category,
            account_login=live_login,
            server=live_server,
            extra={
                "triggeredAtUtc": payload.get("triggeredAtUtc"),
                "triggeredBy": _clean_text(payload.get("triggeredBy")),
            },
        )

    if (
        active is False
        and payload.get("releaseAuthorized") is True
        and _clean_text(payload.get("releasedBy"))
        and _clean_text(payload.get("releaseReason"))
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
            "releasedAtUtc": payload.get("releasedAtUtc"),
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


def persist_operator_emergency_stop(
    path: Path,
    *,
    account_login: int,
    server: str,
    operator_id: str,
    reason: str = "OPERATOR_EMERGENCY_STOP",
    now_utc: float | None = None,
) -> dict:
    """Persist an explicit operator-triggered Emergency Stop bound to account+server."""
    login = _positive_login(account_login)
    srv = _clean_text(server)
    op_id = _clean_text(operator_id)
    if login is None or not srv or not op_id:
        raise ValueError("account_login, server, and operator_id are required to persist operator stop")

    record = {
        "schemaVersion": 1,
        "emergencyStopActive": True,
        "blockNewOrders": True,
        "allowProtectivePositionManagement": True,
        "stopCategory": "OPERATOR_EMERGENCY_STOP",
        "reason": _clean_text(reason or "OPERATOR_EMERGENCY_STOP"),
        "accountLogin": login,
        "server": srv,
        "triggeredBy": op_id,
        "triggeredAtUtc": int(time.time() if now_utc is None else now_utc),
        "releaseAuthorized": False,
    }
    _atomic_write_json(Path(path), record)
    return read_bound_emergency_stop_latch(path, account_login=login, server=srv)


def initialize_or_recover_emergency_stop_latch(
    path: Path,
    *,
    account_login: int,
    server: str,
    operator_authenticated: bool = False,
    operator_id: str = "",
    approval_reason: str = "",
    uncertain_entry_state: dict | None = None,
    recovery_evidence_verified: bool = False,
    now_utc: float | None = None,
) -> dict:
    """Distinct initialization/recovery flow for missing, corrupt, or mismatched latch files."""
    login = _positive_login(account_login)
    srv = _clean_text(server)
    op_id = _clean_text(operator_id)
    reason = _clean_text(approval_reason)
    current = read_bound_emergency_stop_latch(path, account_login=login, server=srv)

    if login is None or not srv:
        return {**current, "recoveryDenied": True, "recoveryDeniedReason": "ACCOUNT_UNVERIFIED"}
    if operator_authenticated is not True or not op_id or not reason:
        return {**current, "recoveryDenied": True, "recoveryDeniedReason": "OPERATOR_AUTH_REQUIRED"}
    if recovery_evidence_verified is not True:
        return {**current, "recoveryDenied": True, "recoveryDeniedReason": "RECOVERY_EVIDENCE_REQUIRED"}
    if current["stopCategory"] not in ("FAIL_CLOSED_STARTUP", "FAIL_CLOSED_CORRUPT", "FAIL_CLOSED_ACCOUNT_MISMATCH", "FAIL_CLOSED_UNVERIFIED"):
        return {**current, "recoveryDenied": True, "recoveryDeniedReason": "USE_STANDARD_OPERATOR_RELEASE"}

    frozen, freeze_reason = _has_active_uncertain_entry(uncertain_entry_state, login=login, server=srv)
    if frozen:
        return {**current, "recoveryDenied": True, "recoveryDeniedReason": freeze_reason}

    record = {
        "schemaVersion": 1,
        "emergencyStopActive": False,
        "blockNewOrders": False,
        "allowProtectivePositionManagement": True,
        "stopCategory": "AUTHORIZED_CLEAR",
        "accountLogin": login,
        "server": srv,
        "releaseAuthorized": True,
        "releasedBy": op_id,
        "releaseReason": reason,
        "releasedAtUtc": int(time.time() if now_utc is None else now_utc),
        "previousStopReason": current.get("reason") or "RECOVERY_INITIALIZED",
    }
    _atomic_write_json(Path(path), record)
    result = read_bound_emergency_stop_latch(path, account_login=login, server=srv)
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
    """Release an existing account-bound OPERATOR_EMERGENCY_STOP only."""
    login = _positive_login(account_login)
    srv = _clean_text(server)
    op_id = _clean_text(operator_id)
    reason = _clean_text(approval_reason)
    current = read_bound_emergency_stop_latch(path, account_login=login, server=srv)

    if login is None or not srv:
        return {**current, "releaseDenied": True, "releaseDeniedReason": "ACCOUNT_UNVERIFIED"}
    if operator_authenticated is not True or not op_id or not reason:
        return {**current, "releaseDenied": True, "releaseDeniedReason": "OPERATOR_AUTH_REQUIRED"}
    if current["stopCategory"] != "OPERATOR_EMERGENCY_STOP" or current["emergencyStopActive"] is not True:
        return {**current, "releaseDenied": True, "releaseDeniedReason": "REQUIRES_ACTIVE_OPERATOR_STOP"}
    if expected_triggered_at_utc is not None and current.get("triggeredAtUtc") != expected_triggered_at_utc:
        return {**current, "releaseDenied": True, "releaseDeniedReason": "STALE_LATCH_VERSION_MISMATCH"}

    frozen, freeze_reason = _has_active_uncertain_entry(uncertain_entry_state, login=login, server=srv)
    if frozen:
        return {**current, "releaseDenied": True, "releaseDeniedReason": freeze_reason}

    record = {
        "schemaVersion": 1,
        "emergencyStopActive": False,
        "blockNewOrders": False,
        "allowProtectivePositionManagement": True,
        "stopCategory": "AUTHORIZED_CLEAR",
        "accountLogin": login,
        "server": srv,
        "releaseAuthorized": True,
        "releasedBy": op_id,
        "releaseReason": reason,
        "releasedAtUtc": int(time.time() if now_utc is None else now_utc),
        "previousStopReason": current.get("reason") or "OPERATOR_EMERGENCY_STOP",
    }
    _atomic_write_json(Path(path), record)
    result = read_bound_emergency_stop_latch(path, account_login=login, server=srv)
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

    login = _positive_login(account_login)
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
        mapped_reason = "BLOCKED_ENTRY_STATE_UNAVAILABLE" if freeze_reason == "UNCERTAIN_ENTRY_STATE_UNVERIFIED" else "BLOCKED_UNCERTAIN_PREVIOUS_ENTRY"
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
