from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import time
from typing import Any


@dataclass(frozen=True, slots=True)
class LiveArmDecision:
    armed: bool
    reason: str
    state: dict[str, Any] | None = None


def normalize_account_mode(value: str | None) -> str:
    mode = str(value or "").strip().upper()
    if mode not in {"DEMO", "LIVE"}:
        return "UNKNOWN"
    return mode


def profile_fingerprint(
    account_mode: str,
    login: int,
    server: str,
    terminal_path: str | None,
) -> str:
    terminal = str(terminal_path or "").strip().replace("/", "\\").lower()
    server_value = str(server or "").strip().lower()
    payload = f"{normalize_account_mode(account_mode)}|{int(login)}|{server_value}|{terminal}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def read_arm_state(path: Path | None) -> tuple[dict[str, Any] | None, str | None]:
    if path is None:
        return None, "ARM_PATH_NOT_CONFIGURED"
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None, "ARM_FILE_MISSING"
    except OSError:
        return None, "ARM_FILE_UNREADABLE"
    try:
        value = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None, "ARM_FILE_INVALID_JSON"
    if not isinstance(value, dict):
        return None, "ARM_FILE_INVALID_SHAPE"
    return value, None


def evaluate_live_arm(
    *,
    path: Path | None,
    bridge_session_id: str,
    configured_account_mode: str,
    account_login: int | None,
    account_server: str | None,
    terminal_path: str | None,
    compatibility_enabled: bool,
    now_ms: int | None = None,
) -> LiveArmDecision:
    if normalize_account_mode(configured_account_mode) != "LIVE":
        return LiveArmDecision(False, "LIVE_NOT_SELECTED")
    if not compatibility_enabled:
        return LiveArmDecision(False, "LIVE_COMPATIBILITY_GATE_DISABLED")
    if account_login is None or int(account_login) <= 0:
        return LiveArmDecision(False, "ACCOUNT_LOGIN_UNAVAILABLE")
    if not str(account_server or "").strip():
        return LiveArmDecision(False, "ACCOUNT_SERVER_UNAVAILABLE")
    if not str(terminal_path or "").strip():
        return LiveArmDecision(False, "TERMINAL_PATH_UNAVAILABLE")

    state, error = read_arm_state(path)
    if error is not None:
        return LiveArmDecision(False, error)
    assert state is not None

    try:
        version = int(state.get("version", 0) or 0)
    except (TypeError, ValueError):
        return LiveArmDecision(False, "ARM_VERSION_INVALID", state)
    if version not in {1, 2}:
        return LiveArmDecision(False, "ARM_VERSION_INVALID", state)
    if state.get("armed") is not True:
        return LiveArmDecision(False, "ARM_STATE_DISARMED", state)
    if version == 2 and str(state.get("scope") or "").strip().upper() != "BRIDGE_SESSION":
        return LiveArmDecision(False, "ARM_SCOPE_INVALID", state)
    if normalize_account_mode(state.get("accountMode")) != "LIVE":
        return LiveArmDecision(False, "ARM_ACCOUNT_MODE_MISMATCH", state)
    if str(state.get("bridgeSessionId") or "") != str(bridge_session_id):
        return LiveArmDecision(False, "ARM_BRIDGE_SESSION_MISMATCH", state)

    try:
        armed_login = int(state.get("accountLogin"))
    except (TypeError, ValueError):
        return LiveArmDecision(False, "ARM_LOGIN_INVALID", state)
    if armed_login != int(account_login):
        return LiveArmDecision(False, "ARM_LOGIN_MISMATCH", state)

    if str(state.get("server") or "").strip().lower() != str(account_server or "").strip().lower():
        return LiveArmDecision(False, "ARM_SERVER_MISMATCH", state)

    expected_fingerprint = profile_fingerprint(
        "LIVE",
        int(account_login),
        str(account_server),
        terminal_path,
    )
    if str(state.get("profileFingerprint") or "").lower() != expected_fingerprint:
        return LiveArmDecision(False, "ARM_PROFILE_MISMATCH", state)

    # Version 1 remains TTL-bound for backward compatibility. Version 2 is
    # intentionally bound to the current bridge process session instead. A
    # bridge restart changes bridgeSessionId and therefore invalidates v2.
    if version == 1:
        current_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
        try:
            expires_at = int(state.get("expiresAt"))
        except (TypeError, ValueError):
            return LiveArmDecision(False, "ARM_EXPIRY_INVALID", state)
        if expires_at <= current_ms:
            return LiveArmDecision(False, "ARM_EXPIRED", state)

    return LiveArmDecision(True, "ARMED", state)
