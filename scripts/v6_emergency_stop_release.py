#!/usr/bin/env python3
"""Release the V6 web Emergency Stop latch (hardening/go-live, DECISIONS D-011).

The web "Emergency Stop" writes `.runtime/v6-stop-intent.flag` and an
account-bound latch `.runtime/v6-emergency-stop-latch.json`. Both block new
entries. This console tool (run on the trading host = operator presence) does
the CAS release through `authorize_emergency_stop_release` and then removes the
stop-intent flag. It refuses while an uncertain entry is frozen for the account.

    python scripts/v6_emergency_stop_release.py status --login 123456 --server Broker-Demo
    python scripts/v6_emergency_stop_release.py release --login 123456 --server Broker-Demo \
        --operator "<your name>" --reason "positions reconciled" --confirm
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import v6_emergency_stop_gate as gate  # noqa: E402
import v6_go_live_guard as guard  # noqa: E402

RUNTIME = HERE.parent / ".runtime"


def paths(runtime: Path) -> tuple[Path, Path, Path]:
    return (runtime / "v6-emergency-stop-latch.json", runtime / "v6-stop-intent.flag",
            runtime / "v6-uncertain-entry-state.json")


def status(runtime: Path, login: int, server: str) -> dict:
    latch, intent, _ = paths(runtime)
    with gate._exclusive_latch_lock(latch):
        state = gate.read_bound_emergency_stop_latch(latch, account_login=login, server=server)
    return {"stopIntentActive": intent.exists(), "latchReason": state.get("reason"),
            "stopCategory": state.get("stopCategory"), "blockNewOrders": bool(state.get("blockNewOrders")),
            "latchFilePresent": latch.exists()}


def release(runtime: Path, login: int, server: str, operator: str, reason: str) -> dict:
    latch, intent, uncertain = paths(runtime)
    try:
        uncertain_state = json.loads(uncertain.read_text(encoding="utf-8")) if uncertain.exists() else {}
    except (OSError, ValueError):
        return {"ok": False, "reason": "UNCERTAIN_ENTRY_STATE_UNREADABLE"}
    result = {"ok": True}
    if latch.exists():
        with gate._exclusive_latch_lock(latch):
            current = gate.read_bound_emergency_stop_latch(latch, account_login=login, server=server)
        if current.get("stopCategory") == "OPERATOR_EMERGENCY_STOP":
            res = gate.authorize_emergency_stop_release(
                latch, account_login=login, server=server, operator_authenticated=True,
                operator_id=operator, approval_reason=reason, uncertain_entry_state=uncertain_state,
                expected_stop_revision=str(current.get("stopRevision") or ""),
            )
            if res.get("releaseDenied"):
                return {"ok": False, "reason": res.get("releaseDeniedReason")}
            result["latch"] = "AUTHORIZED_CLEAR"
        elif current.get("stopCategory") != "AUTHORIZED_CLEAR":
            return {"ok": False, "reason": f"LATCH_NOT_RELEASABLE:{current.get('reason')}",
                    "hint": "Corrupt or other-account latch: inspect the file manually before moving it aside."}
    if intent.exists():
        if any(isinstance(v, dict) and str(v.get("accountLogin")) == str(login) for v in uncertain_state.values()):
            return {"ok": False, "reason": "UNCERTAIN_ENTRY_FROZEN"}
        intent.unlink()
        result["stopIntent"] = "REMOVED"
    guard.log_event("EMERGENCY_STOP_RELEASED", {"operator": operator, "reason": reason, "login": login})
    return {**result, **status(runtime, login, server)}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["status", "release"])
    ap.add_argument("--login", type=int, required=True)
    ap.add_argument("--server", required=True)
    ap.add_argument("--operator", default="")
    ap.add_argument("--reason", default="")
    ap.add_argument("--confirm", action="store_true")
    ap.add_argument("--runtime-dir", type=Path, default=RUNTIME)
    a = ap.parse_args(argv)
    if a.cmd == "status":
        print(json.dumps(guard.redact(status(a.runtime_dir, a.login, a.server))))
        return 0
    if not (a.confirm and a.operator.strip() and a.reason.strip()):
        print(json.dumps({"ok": False, "reason": "REQUIRES --confirm --operator --reason"}))
        return 2
    out = release(a.runtime_dir, a.login, a.server, a.operator.strip(), a.reason.strip())
    print(json.dumps(guard.redact(out)))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
