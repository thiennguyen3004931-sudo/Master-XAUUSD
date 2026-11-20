#!/usr/bin/env python3
"""Stage 4 (M4) — Windows & MT5 Read-Only Environment Verifier.
- Strictly READ-ONLY: NEVER sends, modifies, or closes any MT5 order.
- Masks account IDs and never prints tokens, passwords, or secrets.
- Returns status='BLOCKED' honestly when run outside Windows or when MT5 Terminal is unreachable.
"""
import json
import os
import platform
import subprocess
import sys
from pathlib import Path


def _mask_login(val):
    s = str(val or "").strip()
    if len(s) <= 3:
        return "***"
    return "***" + s[-3:]


def main():
    root = Path(__file__).resolve().parents[1]
    git_sha = "UNKNOWN"
    try:
        git_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, stderr=subprocess.DEVNULL).decode("utf-8").strip()
    except Exception:
        pass

    result = {
        "ok": False,
        "status": "BLOCKED",
        "platform": sys.platform,
        "hostname": platform.node(),
        "botRoot": str(root),
        "deployedCommitSha": git_sha,
        "mt5ReadOnlyVerified": False,
        "liveArmed": None,  # Not checked by this read-only broker probe; do not assert DISARMED
        "liveAuthorization": "NOT_GRANTED",
        "readinessClassification": "LIVE_BLOCKED",
        "operatingProcessVerified": False,
        "riskControlsVerified": False,
        "checks": {},
        "ownerActionRequired": [],
    }

    if sys.platform != "win32":
        result["checks"]["windowsHost"] = "BLOCKED_NON_WINDOWS_HOST"
        result["ownerActionRequired"] = [
            "1. Chạy trên máy Windows đang vận hành bot: python scripts/verify-windows-mt5-readonly.py",
            "2. Kiểm tra git rev-parse HEAD khớp với commit release trên GitHub.",
            "3. Xác nhận MT5 Terminal đang kết nối đúng tài khoản, đọc được positions/orders/deals và LIVE ARM đang khóa (liveArmed=false).",
        ]
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    try:
        import MetaTrader5 as mt5  # type: ignore
    except ImportError:
        result["checks"]["mt5Library"] = "BLOCKED_MT5_PACKAGE_MISSING"
        result["ownerActionRequired"].append("Cài đặt hoặc dùng Python venv có MetaTrader5 trên máy Windows.")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if not mt5.initialize():
        result["checks"]["mt5Initialize"] = "BLOCKED_TERMINAL_UNREACHABLE"
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    try:
        term = mt5.terminal_info()
        acct = mt5.account_info()
        if term is None or acct is None:
            result["checks"]["mt5Account"] = "BLOCKED_ACCOUNT_UNAVAILABLE"
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0

        real_const = int(getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2))
        mode_str = "REAL" if int(getattr(acct, "trade_mode", -1)) == real_const else "DEMO_OR_CONTEST"
        gold_sym = next((s for s in ("XAUUSD.G", "XAUUSD", "GOLD") if mt5.symbol_info(s) is not None), None)
        sym_info = mt5.symbol_info(gold_sym) if gold_sym else None
        positions = mt5.positions_get()
        orders = mt5.orders_get()

        result["checks"] = {
            "terminalConnected": bool(getattr(term, "connected", False)),
            "tradeAllowed": bool(getattr(term, "trade_allowed", False)),
            "accountMasked": _mask_login(getattr(acct, "login", "")),
            "server": str(getattr(acct, "server", "")),
            "accountMode": mode_str,
            "goldSymbol": gold_sym,
            "contractSize": float(getattr(sym_info, "trade_contract_size", 0) or 0) if sym_info else None,
            "volumeStep": float(getattr(sym_info, "volume_step", 0) or 0) if sym_info else None,
            "positionsReadable": positions is not None,
            "openPositionsCount": len(positions) if positions is not None else None,
            "ordersReadable": orders is not None,
            "pendingOrdersCount": len(orders) if orders is not None else None,
        }
        result["mt5ReadOnlyVerified"] = bool(
            result["checks"]["terminalConnected"] and gold_sym and positions is not None and orders is not None
        )
        result["ok"] = result["mt5ReadOnlyVerified"]
        result["status"] = "BROKER_READONLY_OBSERVED" if result["ok"] else "BLOCKED"
        # Probe of the MT5 Python session is not proof of the active V6
        # gateway process, its ARM state, deployed SHA or loss controls.
        # Therefore LIVE authorization remains explicitly blocked.
    finally:
        mt5.shutdown()

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
