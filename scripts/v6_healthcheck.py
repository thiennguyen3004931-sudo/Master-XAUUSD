#!/usr/bin/env python3
"""Heartbeat health check for the V6 runtime (hardening/go-live).

Exit codes: 0 healthy, 1 stale/missing heartbeat, 2 kill switch active.
Schedule it every 1-5 minutes (Windows Task Scheduler) with --alert to get a
Telegram message when the bot stops cycling.

    python scripts/v6_healthcheck.py --max-age 180 --alert
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import v6_go_live_guard as guard


SERVER_SOURCE = HERE / "xauusd-standalone-server.mjs"


def _public_default_vault_key() -> str | None:
    """Built-in fallback key of the V6 server (AUDIT S-3), read from its source.

    That key is public in the repo, so a Telegram token "encrypted" with it is only
    obfuscated. It is read at runtime instead of being copied here.
    """
    try:
        m = re.search(r'ZIQ_TG_MASTER_SECRET \|\| "([^"]+)"', SERVER_SOURCE.read_text(encoding="utf-8"))
    except OSError:
        return None
    return m.group(1) if m else None


def _is_public_default(value: str) -> bool:
    default = _public_default_vault_key()
    return default is not None and value == default


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
