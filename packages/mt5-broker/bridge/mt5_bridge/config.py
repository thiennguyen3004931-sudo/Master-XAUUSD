from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int_optional(name: str) -> int | None:
    value = os.getenv(name, "").strip()
    return int(value) if value else None


def _json_dict(name: str, default: dict[str, object]) -> dict[str, object]:
    raw = os.getenv(name)
    if not raw:
        return default
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError(f"{name} must contain a JSON object")
    return value


def _account_mode() -> str:
    mode = os.getenv("MT5_ACCOUNT_MODE", "DEMO").strip().upper()
    if mode not in {"DEMO", "LIVE"}:
        raise ValueError("MT5_ACCOUNT_MODE must be DEMO or LIVE")
    return mode


@dataclass(frozen=True, slots=True)
class Settings:
    host: str
    port: int
    api_key: str
    trading_enabled: bool
    allow_real_account: bool
    allowed_logins: frozenset[int]
    terminal_path: str | None
    login: int | None
    password: str | None
    server: str | None
    portable: bool
    initialize_timeout_ms: int
    fail_startup_if_disconnected: bool
    symbol_map: dict[str, str]
    max_spread_points: dict[str, float]
    magic_number: int
    deviation_points: int
    ledger_path: Path
    log_level: str
    account_mode: str = "DEMO"
    live_arm_state_path: Path | None = None
    live_compatibility_enabled: bool = False

    @classmethod
    def from_env(cls) -> "Settings":
        api_key = os.getenv("MT5_API_KEY", "").strip()
        if len(api_key) < 16:
            raise ValueError("MT5_API_KEY must contain at least 16 characters")

        allowed = frozenset(
            int(item.strip())
            for item in os.getenv("MT5_ALLOWED_LOGINS", "").split(",")
            if item.strip()
        )
        symbol_map_raw = _json_dict("MT5_SYMBOL_MAP_JSON", {"XAUUSD": "XAUUSD"})
        spread_raw = _json_dict("MT5_MAX_SPREAD_POINTS_JSON", {"XAUUSD": 50})

        symbol_map = {str(key): str(value) for key, value in symbol_map_raw.items()}
        max_spread = {str(key): float(value) for key, value in spread_raw.items()}
        live_arm_raw = os.getenv("MT5_LIVE_ARM_STATE_PATH", "").strip()

        return cls(
            host=os.getenv("MT5_BRIDGE_HOST", "127.0.0.1"),
            port=int(os.getenv("MT5_BRIDGE_PORT", "8765")),
            api_key=api_key,
            trading_enabled=_bool("MT5_TRADING_ENABLED", False),
            allow_real_account=_bool("MT5_ALLOW_REAL_ACCOUNT", False),
            allowed_logins=allowed,
            terminal_path=os.getenv("MT5_TERMINAL_PATH") or None,
            login=_int_optional("MT5_LOGIN"),
            password=os.getenv("MT5_PASSWORD") or None,
            server=os.getenv("MT5_SERVER") or None,
            portable=_bool("MT5_PORTABLE", False),
            initialize_timeout_ms=int(os.getenv("MT5_INITIALIZE_TIMEOUT_MS", "60000")),
            fail_startup_if_disconnected=_bool("MT5_FAIL_STARTUP_IF_DISCONNECTED", True),
            symbol_map=symbol_map,
            max_spread_points=max_spread,
            magic_number=int(os.getenv("MT5_MAGIC_NUMBER", "260806")),
            deviation_points=int(os.getenv("MT5_DEVIATION_POINTS", "50")),
            ledger_path=Path(os.getenv("MT5_LEDGER_PATH", ".\\data\\mt5_bridge.sqlite3")),
            log_level=os.getenv("MT5_LOG_LEVEL", "INFO"),
            account_mode=_account_mode(),
            live_arm_state_path=Path(live_arm_raw) if live_arm_raw else None,
            live_compatibility_enabled=_bool("XAUUSD_PHASE7C_ALLOW_LIVE_TRADING", False),
        )

    def broker_symbol(self, canonical: str) -> str:
        return self.symbol_map.get(canonical, canonical)

    def canonical_symbol(self, broker_symbol: str) -> str:
        for canonical, broker in self.symbol_map.items():
            if broker == broker_symbol:
                return canonical
        return broker_symbol
