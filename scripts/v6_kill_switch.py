#!/usr/bin/env python3
"""Operator kill switch for the V6 runtime (hardening/go-live).

Usage (run from the repository root on the trading PC/VPS):

    python scripts/v6_kill_switch.py status
    python scripts/v6_kill_switch.py on  --reason "manual stop"
    python scripts/v6_kill_switch.py on  --flatten --confirm-flatten [--broker-symbol XAUUSD.G]
    python scripts/v6_kill_switch.py off

``on`` writes the kill-switch flag file; every NEW entry/DCA is blocked
immediately on the next probe cycle (existing SL/TP management keeps working).
``--flatten`` additionally asks the MT5 probe to close every open gold
position on the connected terminal account (requires --confirm-flatten).
``off`` removes the flag. It does NOT clear the separate V6 emergency-stop
latch / stop-intent quarantine, which have their own release procedure.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import v6_go_live_guard as guard

PROBE = HERE / "mt5-direct-probe.py"


def run_flatten(broker_symbol: str, login: str | None, server: str | None, runner=subprocess.run) -> dict:
    cfg = {"action": guard.OPERATOR_FLATTEN_ACTION, "confirmFlatten": True, "brokerSymbol": broker_symbol}
    if login:
        cfg["login"] = login
    if server:
        cfg["server"] = server
    proc = runner([sys.executable, str(PROBE), "--stdin"], input=json.dumps(cfg), capture_output=True,
                  text=True, timeout=120)
    try:
        out = json.loads((proc.stdout or "").strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"ok": False, "message": "Probe returned no JSON", "returncode": proc.returncode}
    return out.get("actionResult") or {"ok": False, "message": out.get("errorMessage") or "No action result"}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    on = sub.add_parser("on")
    on.add_argument("--reason", default="operator")
    on.add_argument("--flatten", action="store_true")
    on.add_argument("--confirm-flatten", action="store_true")
    on.add_argument("--broker-symbol", default="XAUUSD.G")
    on.add_argument("--login", default=None)
    on.add_argument("--server", default=None)
    sub.add_parser("off")
    args = ap.parse_args(argv)
    s = guard.load_settings()

    if args.cmd == "status":
        active, why = guard.kill_switch_active(s)
        print(json.dumps({"killSwitchActive": active, "reason": why, "file": str(s.kill_switch_file),
                          "dryRun": s.dry_run, "liveConfirmed": s.live_confirmed}))
        return 0
    if args.cmd == "off":
        removed = guard.deactivate_kill_switch(s)
        guard.log_event("KILL_SWITCH_OFF", {"removed": removed}, settings=s)
        print(json.dumps({"killSwitchActive": guard.kill_switch_active(s)[0], "removed": removed}))
        return 0

    payload = guard.activate_kill_switch(s, args.reason, flatten=args.flatten)
    guard.log_event("KILL_SWITCH_ON", payload, settings=s)
    guard.send_alert("KILL_SWITCH_ON", f"Kill switch ON: {args.reason}", dedupe_window_sec=0)
    result = {"killSwitchActive": True, **payload}
    if args.flatten:
        if not args.confirm_flatten:
            print(json.dumps({**result, "flatten": "SKIPPED_CONFIRMATION_REQUIRED"}))
            return 2
        result["flatten"] = run_flatten(args.broker_symbol, args.login, args.server)
    print(json.dumps(guard.redact(result), ensure_ascii=False))
    return 0 if not args.flatten or result["flatten"].get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
