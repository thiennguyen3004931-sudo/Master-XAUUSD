from __future__ import annotations

import os
from pathlib import Path
import sys
from typing import Any

try:
    import MetaTrader5 as mt5
except ImportError as exc:
    print(f"PHASE6E_MAXBARS_PROBE_FAIL:MetaTrader5 unavailable:{exc}", file=sys.stderr)
    raise SystemExit(2)


def load_env_file(path: str | None) -> None:
    if not path:
        return
    env_path = Path(path)
    if not env_path.exists():
        raise FileNotFoundError(f"Bridge env not found: {env_path}")
    for raw in env_path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_int(name: str) -> int | None:
    raw = os.getenv(name, "").strip()
    return int(raw) if raw else None


def initialize() -> None:
    kwargs: dict[str, Any] = {
        "timeout": int(os.getenv("MT5_INITIALIZE_TIMEOUT_MS", "60000")),
        "portable": env_bool("MT5_PORTABLE", False),
    }
    terminal_path = os.getenv("MT5_TERMINAL_PATH", "").strip()
    login = env_int("MT5_LOGIN")
    password = os.getenv("MT5_PASSWORD", "").strip()
    server = os.getenv("MT5_SERVER", "").strip()
    if terminal_path:
        kwargs["path"] = terminal_path
    if login is not None:
        kwargs["login"] = login
    if password:
        kwargs["password"] = password
    if server:
        kwargs["server"] = server
    if not mt5.initialize(**kwargs):
        raise RuntimeError(f"initialize:{mt5.last_error()}")


def main() -> int:
    try:
        load_env_file(os.getenv("ZIQ_BRIDGE_ENV"))
        initialize()
        info = mt5.terminal_info()
        if info is None:
            raise RuntimeError(f"terminal_info:{mt5.last_error()}")
        maxbars = int(getattr(info, "maxbars", 0) or 0)
        if maxbars <= 0:
            raise RuntimeError(f"invalid maxbars:{maxbars}")
        print(f"PHASE6E_MAXBARS_PROBE_VALUE={maxbars}")
        print("PHASE6E_MAXBARS_PROBE_STATUS=PASS")
        return 0
    except Exception as exc:
        print(f"PHASE6E_MAXBARS_PROBE_FAIL:{exc}", file=sys.stderr)
        return 1
    finally:
        try:
            mt5.shutdown()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
