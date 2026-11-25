#!/usr/bin/env python3
"""Optional Telegram command listener for the kill switch (hardening/go-live).

Accepts commands ONLY from TELEGRAM_CHAT_ID (from env/.env, never from code):

    /status                 -> guard + heartbeat status
    /kill [reason]          -> kill switch ON (blocks new entries)
    /kill_flatten <PIN>     -> kill switch ON + close all gold positions
                               (requires XAUUSD_TELEGRAM_FLATTEN_PIN to be set
                               and to match; disabled when unset)
    /resume <PIN>           -> kill switch OFF (requires the same PIN)

Run:  python scripts/v6_telegram_kill_listener.py
"""
from __future__ import annotations

import hmac
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import v6_go_live_guard as guard
import v6_healthcheck as health
import v6_kill_switch as kill


def handle_command(text: str, chat_id: str, env: dict, settings: guard.GuardSettings, flatten_fn=None) -> str:
    allowed = str(env.get("TELEGRAM_CHAT_ID") or "").strip()
    if not allowed or str(chat_id).strip() != allowed:
        return ""  # silently ignore foreign chats
    parts = str(text or "").strip().split()
    if not parts:
        return ""
    cmd = parts[0].split("@")[0].lower()
    pin = str(env.get("XAUUSD_TELEGRAM_FLATTEN_PIN") or "")
    arg = parts[1] if len(parts) > 1 else ""
    if cmd == "/status":
        _, report = health.evaluate(180.0, settings=settings)
        return json.dumps(report)
    if cmd == "/kill":
        guard.activate_kill_switch(settings, " ".join(parts[1:]) or "telegram")
        guard.log_event("KILL_SWITCH_ON", {"source": "telegram"}, settings=settings)
        return "Kill switch ON: new entries blocked."
    if cmd in ("/kill_flatten", "/resume"):
        if not pin or not hmac.compare_digest(arg, pin):
            return "Rejected: PIN missing or wrong."
        if cmd == "/resume":
            guard.deactivate_kill_switch(settings)
            guard.log_event("KILL_SWITCH_OFF", {"source": "telegram"}, settings=settings)
            return "Kill switch OFF."
        guard.activate_kill_switch(settings, "telegram flatten", flatten=True)
        res = (flatten_fn or (lambda: kill.run_flatten(env.get("XAUUSD_BROKER_SYMBOL") or "XAUUSD.G", None, None)))()
        return f"Kill switch ON + flatten: {res.get('status') or res.get('message')}"
    return ""


def main() -> int:  # pragma: no cover - network loop
    env = {**guard.read_dotenv(), **os.environ}
    token = str(env.get("TELEGRAM_BOT_TOKEN") or "").strip()
    if not token or not env.get("TELEGRAM_CHAT_ID"):
        print("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required", file=sys.stderr)
        return 2
    settings = guard.load_settings(env)
    base = f"https://api.telegram.org/bot{token}"
    offset = 0
    backoff = 1.0
    while True:
        try:
            q = urllib.parse.urlencode({"timeout": 25, "offset": offset})
            data = json.loads(urllib.request.urlopen(f"{base}/getUpdates?{q}", timeout=35).read())
            backoff = 1.0
            for upd in data.get("result", []):
                offset = int(upd["update_id"]) + 1
                msg = upd.get("message") or {}
                reply = handle_command(msg.get("text", ""), (msg.get("chat") or {}).get("id", ""), env, settings)
                if reply:
                    body = urllib.parse.urlencode({"chat_id": env["TELEGRAM_CHAT_ID"], "text": reply}).encode()
                    urllib.request.urlopen(urllib.request.Request(f"{base}/sendMessage", data=body), timeout=10).read()
        except Exception as exc:  # reconnect with exponential backoff
            guard.log_event("TELEGRAM_LISTENER_ERROR", {"error": str(exc)[:200]}, settings=settings)
            time.sleep(backoff)
            backoff = min(60.0, backoff * 2)


if __name__ == "__main__":
    raise SystemExit(main())
