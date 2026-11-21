"""Offline-only durable emergency-stop latch candidate for V6 (#7).

No MT5 imports, order sending, ARM controls or automatic release. This library
is NOT imported into the live execution path. Missing/corrupt state blocks.
Caller authentication, runtime ownership and a separately authorized reset
must be reviewed before any production integration.
"""
import json
import os
import tempfile
import time
from pathlib import Path


def _atomic_write_json(path: Path, payload: dict) -> None:
    """Publish a complete latch, flushing the file before atomic replacement."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
        # POSIX directory fsync reduces rename loss after an abrupt power cut.
        # Windows durability still needs host-level acceptance testing.
        if os.name == "posix":
            parent_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(parent_fd)
            finally:
                os.close(parent_fd)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def read_emergency_stop_latch(path: Path) -> dict:
    """A missing, unreadable, corrupt or unapproved clear is always blocking."""
    base = {
        "emergencyStopActive": True,
        "blockNewOrders": True,
        "allowProtectivePositionManagement": True,
    }
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {**base, "reason": "STOP_LATCH_MISSING_UNVERIFIED"}
    except (OSError, ValueError, UnicodeError):
        return {**base, "reason": "STOP_LATCH_UNREADABLE_FAIL_CLOSED"}
    if not isinstance(payload, dict) or payload.get("emergencyStopActive") is not True:
        return {**base, "reason": "STOP_LATCH_STATE_UNVERIFIED"}
    return {
        **base,
        "reason": str(payload.get("reason") or "EMERGENCY_STOP_ACTIVE")[:128],
        "triggeredAtUtc": payload.get("triggeredAtUtc"),
    }


def persist_emergency_stop_latch(
    path: Path, *, reason: str = "EMERGENCY_STOP", now_utc: float | None = None
) -> dict:
    """Permanently latch NEW entries off; does not disable protective SL work."""
    record = {
        "emergencyStopActive": True,
        "blockNewOrders": True,
        "allowProtectivePositionManagement": True,
        "reason": str(reason or "EMERGENCY_STOP")[:128],
        "triggeredAtUtc": int(time.time() if now_utc is None else now_utc),
    }
    _atomic_write_json(Path(path), record)
    return read_emergency_stop_latch(path)
