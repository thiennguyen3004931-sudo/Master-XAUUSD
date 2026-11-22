"""G1 P0 cross-process STOP / new-order linearization protocol (#7).

Strictly NO-REAL-MT5 / OFFLINE:
- NEVER imports MetaTrader5, NEVER calls real `order_send`, NEVER mutates ARM/BOT_MODE.
- Solves the cross-process STOP vs new-entry ordering problem without deadlocking STOP
  on slow broker IO:
  1. Non-blocking STOP intent (`v6-stop-intent.flag`) is written atomically (temp+fsync+
     os.replace) WITHOUT waiting on broker `order_send`, followed by `_exclusive_latch_lock`
     on `v6-emergency-stop-latch.json` (which is NEVER held across broker IO).
  2. New-entry sender serializes under cross-process `v6-new-order-execution.lock`,
     checks `v6-stop-intent.flag` + `v6-emergency-stop-latch.json` under
     `_exclusive_latch_lock`, persists `v6-uncertain-entry-state.json` (`PENDING_SEND`)
     BEFORE `order_send`, and re-checks `v6-stop-intent.flag` immediately before send.
  3. On non-Windows hosts or without genuine DPAPI/effective-ACL + reason-bound CAS
     release proof, new entries fail closed (`liveAuthorized=False`).
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import time
from typing import Any, Callable


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    data = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    with open(tmp_path, "w", encoding="utf-8") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp_path, path)


@contextmanager
def cross_process_file_lock(lock_path: Path):
    """Cross-process exclusive file lock (fcntl on POSIX, msvcrt on Windows)."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a+b") as fh:
        if os.name == "posix":
            import fcntl

            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        else:
            import msvcrt

            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)


def persist_nonblocking_stop_intent_and_latch(
    *,
    runtime_dir: Path,
    account_login: int,
    server: str,
    operator_id: str,
    reason: str = "OPERATOR_EMERGENCY_STOP",
    now_utc: float | None = None,
) -> dict[str, Any]:
    """Persist STOP intent immediately (never waits on broker IO), then update latch."""
    ts = int(time.time() if now_utc is None else now_utc)
    stop_intent_path = runtime_dir / "v6-stop-intent.flag"
    latch_path = runtime_dir / "v6-emergency-stop-latch.json"
    latch_lock_path = runtime_dir / "v6-emergency-stop-latch.json.lock"

    stop_rev = secrets.token_hex(16)
    intent_payload = {
        "schemaVersion": 1,
        "stopIntentActive": True,
        "accountLogin": int(account_login),
        "server": str(server).strip(),
        "operatorId": str(operator_id).strip(),
        "reason": str(reason).strip(),
        "stopRevision": stop_rev,
        "requestedAtUtc": ts,
    }
    _atomic_write_json(stop_intent_path, intent_payload)

    latch_payload = {
        "schemaVersion": 1,
        "accountLogin": int(account_login),
        "server": str(server).strip(),
        "emergencyStopActive": True,
        "blockNewOrders": True,
        "stopCategory": "OPERATOR_STOP",
        "triggeredBy": str(operator_id).strip(),
        "reason": str(reason).strip(),
        "stopRevision": stop_rev,
        "triggeredAtUtc": ts,
    }
    with cross_process_file_lock(latch_lock_path):
        _atomic_write_json(latch_path, latch_payload)

    return latch_payload


def _verify_trusted_release_proof(
    *,
    latch: dict[str, Any],
    account_login: int,
    server: str,
    now_utc: int,
    host_dpapi_verifier: Callable[[dict[str, Any]], bool] | None,
    release_hmac_key: bytes | None,
    max_age_sec: int = 300,
) -> tuple[bool, str]:
    if latch.get("emergencyStopActive") is not False or latch.get("blockNewOrders") is not False:
        return False, "EMERGENCY_STOP_ACTIVE"
    if latch.get("accountLogin") != int(account_login) or str(latch.get("server") or "").strip() != str(server).strip():
        return False, "LATCH_ACCOUNT_SERVER_MISMATCH"

    proof = latch.get("releaseProof")
    if not isinstance(proof, dict):
        return False, "MISSING_TRUSTED_RELEASE_PROOF"
    if host_dpapi_verifier is None or not release_hmac_key:
        return False, "WINDOWS_DPAPI_AND_KEY_CUSTODY_UNVERIFIED"
    if host_dpapi_verifier(latch) is not True:
        return False, "HOST_DPAPI_ACL_VERIFICATION_FAILED"

    released_at = proof.get("releasedAtUtc")
    operator_id = str(proof.get("operatorId") or "").strip()
    release_reason = str(proof.get("approvalReason") or "").strip()
    stop_rev = str(proof.get("stopRevision") or "").strip()
    provided_hmac = str(proof.get("hmacSha256") or "").strip()
    if (
        not isinstance(released_at, int)
        or isinstance(released_at, bool)
        or now_utc - released_at < 0
        or now_utc - released_at > max_age_sec
        or not operator_id
        or not release_reason
        or len(stop_rev) < 16
        or stop_rev != str(latch.get("stopRevision") or "").strip()
        or not provided_hmac
    ):
        return False, "RELEASE_PROOF_INVALID_OR_STALE"

    msg = f"{int(account_login)}|{str(server).strip()}|{stop_rev}|{released_at}|{operator_id}|{release_reason}".encode("utf-8")
    expected_hmac = hmac.new(release_hmac_key, msg, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(provided_hmac, expected_hmac):
        return False, "RELEASE_HMAC_MISMATCH"
    return True, "TRUSTED_RELEASE_VERIFIED"


def execute_linearized_new_order(
    *,
    runtime_dir: Path,
    account_login: int,
    server: str,
    request_id: str,
    mock_order_send: Callable[[dict[str, Any]], dict[str, Any] | None],
    host_dpapi_verifier: Callable[[dict[str, Any]], bool] | None = None,
    release_hmac_key: bytes | None = None,
    now_utc: int | None = None,
    pre_send_hook: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Execute a mock/offline new order under cross-process STOP/send linearization."""
    ts = int(time.time() if now_utc is None else now_utc)
    entry_lock_path = runtime_dir / "v6-new-order-execution.lock"
    latch_lock_path = runtime_dir / "v6-emergency-stop-latch.json.lock"
    latch_path = runtime_dir / "v6-emergency-stop-latch.json"
    stop_intent_path = runtime_dir / "v6-stop-intent.flag"
    uncertain_path = runtime_dir / "v6-uncertain-entry-state.json"
    key = f"{int(account_login)}|{str(server).strip()}"

    with cross_process_file_lock(entry_lock_path):
        if pre_send_hook is not None:
            pre_send_hook()

        with cross_process_file_lock(latch_lock_path):
            if stop_intent_path.exists():
                return {
                    "ok": False,
                    "submitted": False,
                    "status": "BLOCKED_STOP_INTENT_ACTIVE",
                    "liveAuthorized": False,
                }
            if not latch_path.exists():
                return {
                    "ok": False,
                    "submitted": False,
                    "status": "BLOCKED_STOP_LATCH_MISSING",
                    "liveAuthorized": False,
                }
            try:
                latch = json.loads(latch_path.read_text(encoding="utf-8"))
            except Exception:
                return {
                    "ok": False,
                    "submitted": False,
                    "status": "BLOCKED_STOP_LATCH_CORRUPT",
                    "liveAuthorized": False,
                }

            ok_release, release_reason = _verify_trusted_release_proof(
                latch=latch,
                account_login=account_login,
                server=server,
                now_utc=ts,
                host_dpapi_verifier=host_dpapi_verifier,
                release_hmac_key=release_hmac_key,
            )
            if not ok_release:
                return {
                    "ok": False,
                    "submitted": False,
                    "status": "BLOCKED_EMERGENCY_STOP_LATCH",
                    "reason": release_reason,
                    "liveAuthorized": False,
                }

            if uncertain_path.exists():
                try:
                    u_state = json.loads(uncertain_path.read_text(encoding="utf-8"))
                except Exception:
                    return {
                        "ok": False,
                        "submitted": False,
                        "status": "BLOCKED_ENTRY_STATE_CORRUPT",
                        "liveAuthorized": False,
                    }
                if key in u_state:
                    return {
                        "ok": False,
                        "submitted": False,
                        "status": "BLOCKED_UNCERTAIN_PREVIOUS_ENTRY",
                        "liveAuthorized": False,
                    }
            else:
                u_state = {}

            u_state[key] = {
                "requestId": str(request_id),
                "status": "PENDING_SEND",
                "accountLogin": int(account_login),
                "server": str(server).strip(),
                "createdAtUtc": ts,
            }
            _atomic_write_json(uncertain_path, u_state)

        if stop_intent_path.exists():
            return {
                "ok": False,
                "submitted": False,
                "status": "BLOCKED_STOP_INTENT_BEFORE_SEND",
                "liveAuthorized": False,
            }

        try:
            ack = mock_order_send({"requestId": str(request_id), "accountLogin": int(account_login), "server": str(server)})
        except Exception as exc:
            return {
                "ok": False,
                "submitted": True,
                "uncertain": True,
                "status": "UNCERTAIN_ORDER_SEND_EXCEPTION",
                "errorType": type(exc).__name__,
                "liveAuthorized": False,
            }

        if not isinstance(ack, dict) or ack.get("retcode") != 10009 or not ack.get("order"):
            return {
                "ok": False,
                "submitted": True,
                "uncertain": True,
                "status": "UNCERTAIN_BROKER_ACK",
                "liveAuthorized": False,
            }

        if not stop_intent_path.exists():
            with cross_process_file_lock(latch_lock_path):
                cur_state = json.loads(uncertain_path.read_text(encoding="utf-8"))
                cur_state.pop(key, None)
                _atomic_write_json(uncertain_path, cur_state)

        return {
            "ok": True,
            "submitted": True,
            "uncertain": False,
            "status": "MOCK_ORDER_CONFIRMED",
            "order": int(ack["order"]),
            "liveAuthorized": False,
        }
