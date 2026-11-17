#!/usr/bin/env python3
"""Section VIII (Task 13): Dedicated MT5 DEMO Integration Verifier (Real Terminal Only).
- Strictly distinguishes Mock Integration Tests (SafeMockBroker) from Real MT5 DEMO Terminal verification.
- Never sends orders on REAL accounts (trade_mode == ACCOUNT_TRADE_MODE_REAL).
- Never switches DEMO to LIVE.
- Does NOT execute trades merely to test connectivity.
- Reports explicit SKIPPED_NO_MT5_TERMINAL when run in a Linux CI/sandbox environment without Windows MetaTrader 5.
"""
import json
import sys

def main():
    try:
        import MetaTrader5 as mt5  # type: ignore
    except ImportError:
        print(json.dumps({
            "ok": False,
            "status": "SKIPPED_NO_MT5_TERMINAL",
            "environment": sys.platform,
            "isMockBroker": False,
            "demoVerified": False,
            "liveReady": False,
            "message": "Môi trường hiện tại không có thư viện/phần mềm Windows MetaTrader 5 Terminal. Không sử dụng kết quả SafeMockBroker để tuyên bố đã kiểm thử MT5 DEMO thật.",
        }, ensure_ascii=False))
        return 0

    if not mt5.initialize():
        print(json.dumps({
            "ok": False,
            "status": "MT5_TERMINAL_NOT_CONNECTED",
            "isMockBroker": False,
            "demoVerified": False,
            "liveReady": False,
            "message": "Không kết nối được MetaTrader 5 Terminal trên máy hiện tại.",
        }, ensure_ascii=False))
        return 0

    acct = mt5.account_info()
    term = mt5.terminal_info()
    if acct is None or term is None:
        mt5.shutdown()
        print(json.dumps({
            "ok": False,
            "status": "MT5_ACCOUNT_INFO_UNAVAILABLE",
            "demoVerified": False,
            "liveReady": False,
        }, ensure_ascii=False))
        return 0

    real_const = int(getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2))
    demo_const = int(getattr(mt5, "ACCOUNT_TRADE_MODE_DEMO", 0))
    if int(getattr(acct, "trade_mode", -1)) == real_const:
        mt5.shutdown()
        print(json.dumps({
            "ok": False,
            "status": "ABORTED_REAL_ACCOUNT_DETECTED",
            "accountLogin": int(acct.login),
            "server": str(acct.server),
            "demoVerified": False,
            "liveReady": False,
            "message": "PHÁT HIỆN TÀI KHOẢN REAL — Ngừng ngay bộ kiểm thử tích hợp DEMO để bảo đảm an toàn tuyệt đối (không gửi lệnh thật).",
        }, ensure_ascii=False))
        return 0

    is_demo = int(getattr(acct, "trade_mode", -1)) == demo_const
    mt5.shutdown()
    print(json.dumps({
        "ok": is_demo,
        "status": "DEMO_READONLY_PREFLIGHT_OK" if is_demo else "NON_DEMO_ACCOUNT_MODE",
        "accountLogin": int(acct.login),
        "server": str(acct.server),
        "demoVerified": is_demo,
        "liveReady": False,
    }, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
