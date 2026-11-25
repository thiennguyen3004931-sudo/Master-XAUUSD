#!/usr/bin/env python3
"""Heartbeat health check for the V6 runtime (hardening/go-live).

Exit codes: 0 healthy, 1 stale/missing heartbeat, 2 kill switch active.
Schedule it every 1-5 minutes (Windows Task Scheduler) with --alert to get a
Telegram message when the bot stops cycling.

    python scripts/v6_healthcheck.py --max-age 180 --alert
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import v6_go_live_guard as guard


# SHA-256 of the built-in fallback key in xauusd-standalone-server.mjs (AUDIT S-3).
# That key is public in the repo, so a Telegram token "encrypted" with it is only
# obfuscated. Only the digest is kept here so scanners do not flag a literal.
PUBLIC_DEFAULT_TG_VAULT_KEY_SHA256 = "fed7319a6fdfb64dc4a0ae2cef1b23fe34453336aaf0e3a1dbf84d5133bc95e7"


def _is_public_default(value: str) -> bool:
    return hashlib.sha256(value.encode("utf-8")).hexdigest() == PUBLIC_DEFAULT_TG_VAULT_KEY_SHA256


def config_warnings(env=None) -> list[str]:
    """Non-fatal configuration warnings (do not change the exit code)."""
    e = os.environ if env is None else env
    out = []
    vault = str(e.get("ZIQ_TG_MASTER_SECRET") or "").strip()
    if not vault or _is_public_default(vault):
        out.append("TELEGRAM_VAULT_KEY_DEFAULT: set ZIQ_TG_MASTER_SECRET to a long random value (SECURITY.md)")
    elif len(vault) < 32:
        out.append("TELEGRAM_VAULT_KEY_SHORT: ZIQ_TG_MASTER_SECRET should be at least 32 characters")
    return out


def evaluate(max_age: float, heartbeat: Path = guard.DEFAULT_HEARTBEAT_FILE, now: float | None = None,
             settings: guard.GuardSettings | None = None, env=None) -> tuple[int, dict]:
    s = settings or guard.load_settings()
    age = guard.heartbeat_age_sec(heartbeat, now=now)
    ks, why = guard.kill_switch_active(s)
    report = {"heartbeatAgeSec": None if age is None else round(age, 1), "maxAgeSec": max_age,
              "killSwitchActive": ks, "killSwitchReason": why, "dryRun": s.dry_run,
              "warnings": config_warnings(env)}
    if age is None or age > max_age:
        return 1, {**report, "status": "STALE_OR_MISSING_HEARTBEAT"}
    if ks:
        return 2, {**report, "status": "KILL_SWITCH_ACTIVE"}
    return 0, {**report, "status": "HEALTHY"}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-age", type=float, default=180.0)
    ap.add_argument("--alert", action="store_true")
    args = ap.parse_args(argv)
    code, report = evaluate(args.max_age)
    print(json.dumps(report))
    if args.alert and code == 1:
        guard.send_alert("HEARTBEAT_STALE", json.dumps(report), dedupe_key="heartbeat-stale")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
