#!/usr/bin/env python3
"""Go-live guard for the V6 direct MT5 runtime (hardening/go-live).

This module is the last operator-controlled policy layer in front of every
broker mutation performed by ``scripts/mt5-direct-probe.py``. It is purely
additive: it never relaxes an existing gate, it only adds blocking reasons.

Policy (all values come from environment variables; secrets are never read
here):

* Execution mode
  - ``XAUUSD_DRY_RUN`` defaults to ``true``. While true, NO broker mutation is
    sent (new entries, DCA, SL/TP modification, closes). The only exception is
    an explicit operator kill-switch flatten (``kill_switch_flatten``).
  - A REAL (live) account additionally requires BOTH ``XAUUSD_LIVE=true`` AND
    ``XAUUSD_CONFIRM_LIVE=yes`` for any new exposure. These two flags stack on
    top of the existing ARM / account-binding gates; they never replace them.
* Risk
  - Per-trade risk cap ``XAUUSD_RISK_PER_TRADE_PCT`` (default 1.0, hard max 1.0).
    The requested lot is reduced to the risk-sized lot when it is larger; it is
    never increased. Below broker minimum lot -> blocked.
  - Portfolio risk cap ``XAUUSD_MAX_PORTFOLIO_RISK_PCT`` (default 1.5, hard max 1.5).
  - Daily loss cap ``XAUUSD_MAX_DAILY_LOSS_PCT`` (default 3.0) clamps the
    existing daily-loss engine; weekly cap ``XAUUSD_MAX_WEEKLY_LOSS_PCT``
    (default 6.0) is computed from MT5 deal history (fail closed).
  - ``XAUUSD_MAX_OPEN_POSITIONS`` (default 3) and
    ``XAUUSD_MAX_TOTAL_VOLUME_LOTS`` (default 0.20).
  - Spread ceiling ``XAUUSD_MAX_SPREAD_USD`` (default 0.50 USD/oz).
* Calendar filters
  - High-impact news blackout from a JSON calendar file
    (``XAUUSD_NEWS_BLACKOUT_FILE``, default ``config/news-blackout.json``).
    Enabled by default; a missing or expired calendar blocks new entries.
  - Low-liquidity windows (``XAUUSD_LOW_LIQUIDITY_WINDOWS_UTC``, default
    ``20:45-23:15``) plus weekend / Friday-close / Monday-open guards.
* Kill switch
  - File flag ``.runtime/KILL_SWITCH`` (or ``XAUUSD_KILL_SWITCH_FILE``) or env
    ``XAUUSD_KILL_SWITCH=1`` blocks every new entry immediately.
* Clock
  - ``XAUUSD_MAX_CLOCK_SKEW_SEC`` (default 5): a broker tick that appears to be
    in the future relative to the local clock beyond this skew blocks entries.

Everything here is pure / injectable so it can be unit-tested without MT5.
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import re
import time
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from math import floor, isfinite
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent
RUNTIME_DIR = ROOT_DIR / ".runtime"
DEFAULT_KILL_SWITCH_FILE = RUNTIME_DIR / "KILL_SWITCH"
DEFAULT_NEWS_FILE = ROOT_DIR / "config" / "news-blackout.json"
DEFAULT_LOG_FILE = RUNTIME_DIR / "logs" / "v6-guard.jsonl"
DEFAULT_HEARTBEAT_FILE = RUNTIME_DIR / "v6-heartbeat.json"
DEFAULT_ALERT_STATE_FILE = RUNTIME_DIR / "v6-alert-dedupe.json"

HARD_MAX_RISK_PER_TRADE_PCT = 1.0
HARD_MAX_PORTFOLIO_RISK_PCT = 1.5
HARD_MAX_DAILY_LOSS_PCT = 3.0
HARD_MAX_WEEKLY_LOSS_PCT = 6.0

NEW_RISK_ACTIONS = frozenset({"order", "dca_plus"})
PROTECTIVE_ACTIONS = frozenset({"manage_positions", "breakeven", "close"})
OPERATOR_FLATTEN_ACTION = "kill_switch_flatten"
MUTATING_ACTIONS = NEW_RISK_ACTIONS | PROTECTIVE_ACTIONS | {OPERATOR_FLATTEN_ACTION}

_TRUE = {"1", "true", "yes", "on"}


# ---------------------------------------------------------------------------
# Environment helpers
# ---------------------------------------------------------------------------

DOTENV_FILE = ROOT_DIR / ".env"
_DOTENV_PREFIXES = ("XAUUSD_", "TELEGRAM_")


def read_dotenv(path: Path = DOTENV_FILE) -> dict[str, str]:
    """Minimal KEY=VALUE reader for the gitignored repo-root ``.env``.

    Only ``XAUUSD_*`` and ``TELEGRAM_*`` keys are taken. Never logged.
    """
    out: dict[str, str] = {}
    try:
        lines = Path(path).read_text(encoding="utf-8-sig").splitlines()
    except (OSError, UnicodeDecodeError):
        return out
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[7:].strip()
        if not key.startswith(_DOTENV_PREFIXES):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key] = value
    return out


def _env(env: Mapping[str, str] | None) -> Mapping[str, str]:
    if env is not None:
        return env
    if os.environ.get("V6_OFFLINE_TEST_FORBID_REAL_MT5") == "1":
        return os.environ
    merged = dict(read_dotenv())
    merged.update(os.environ)  # real environment wins over .env
    return merged


def _bool(env: Mapping[str, str], name: str, default: bool) -> bool:
    raw = env.get(name)
    if raw is None or not str(raw).strip():
        return default
    return str(raw).strip().lower() in _TRUE


def _float(env: Mapping[str, str], name: str, default: float) -> float:
    raw = env.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        value = float(str(raw).strip())
    except ValueError:
        return default
    return value if isfinite(value) else default


def _int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        return int(str(raw).strip())
    except ValueError:
        return default


@dataclass(frozen=True)
class GuardSettings:
    dry_run: bool = True
    live_flag: bool = False
    confirm_live: bool = False
    risk_per_trade_pct: float = 1.0
    max_portfolio_risk_pct: float = 1.5
    max_daily_loss_pct: float = 3.0
    max_weekly_loss_pct: float = 6.0
    max_open_positions: int = 3
    max_total_volume_lots: float = 0.20
    max_spread_usd: float = 0.50
    sizing_mode: str = "RISK_PERCENT"
    news_filter_enabled: bool = True
    news_file: Path = DEFAULT_NEWS_FILE
    news_before_min: int = 30
    news_after_min: int = 30
    low_liquidity_filter_enabled: bool = True
    low_liquidity_windows: tuple[tuple[int, int], ...] = ((20 * 60 + 45, 23 * 60 + 15),)
    friday_close_utc_min: int = 20 * 60
    monday_open_utc_min: int = 1 * 60
    kill_switch_env: bool = False
    kill_switch_file: Path = DEFAULT_KILL_SWITCH_FILE
    max_clock_skew_sec: float = 5.0
    log_file: Path = DEFAULT_LOG_FILE
    entry_deviation_points: int = 50
    close_deviation_points: int = 50

    @property
    def live_confirmed(self) -> bool:
        return self.live_flag and self.confirm_live


HARD_MAX_ENTRY_DEVIATION_POINTS = 100
HARD_MAX_CLOSE_DEVIATION_POINTS = 300


def parse_windows(raw: str) -> tuple[tuple[int, int], ...]:
    """Parse ``"HH:MM-HH:MM,HH:MM-HH:MM"`` into minute-of-day ranges (UTC)."""
    out: list[tuple[int, int]] = []
    for part in str(raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r"(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})", part)
        if not m:
            raise ValueError(f"Invalid window '{part}' (expected HH:MM-HH:MM)")
        h1, m1, h2, m2 = (int(x) for x in m.groups())
        if not (0 <= h1 <= 23 and 0 <= h2 <= 24 and 0 <= m1 <= 59 and 0 <= m2 <= 59):
            raise ValueError(f"Invalid window '{part}'")
        out.append((h1 * 60 + m1, h2 * 60 + m2))
    return tuple(out)


def load_settings(env: Mapping[str, str] | None = None) -> GuardSettings:
    e = _env(env)
    windows_raw = e.get("XAUUSD_LOW_LIQUIDITY_WINDOWS_UTC")
    try:
        windows = parse_windows(windows_raw) if windows_raw is not None else GuardSettings.low_liquidity_windows
    except ValueError:
        # Invalid operator config must not silently disable the filter.
        windows = ((0, 24 * 60),)
    return GuardSettings(
        dry_run=_bool(e, "XAUUSD_DRY_RUN", True),
        live_flag=_bool(e, "XAUUSD_LIVE", False),
        confirm_live=str(e.get("XAUUSD_CONFIRM_LIVE", "")).strip().lower() == "yes",
        risk_per_trade_pct=max(0.01, min(HARD_MAX_RISK_PER_TRADE_PCT, _float(e, "XAUUSD_RISK_PER_TRADE_PCT", 1.0))),
        max_portfolio_risk_pct=max(0.01, min(HARD_MAX_PORTFOLIO_RISK_PCT, _float(e, "XAUUSD_MAX_PORTFOLIO_RISK_PCT", 1.5))),
        max_daily_loss_pct=max(0.1, min(HARD_MAX_DAILY_LOSS_PCT, _float(e, "XAUUSD_MAX_DAILY_LOSS_PCT", 3.0))),
        max_weekly_loss_pct=max(0.1, min(HARD_MAX_WEEKLY_LOSS_PCT, _float(e, "XAUUSD_MAX_WEEKLY_LOSS_PCT", 6.0))),
        max_open_positions=max(0, _int(e, "XAUUSD_MAX_OPEN_POSITIONS", 3)),
        max_total_volume_lots=max(0.0, _float(e, "XAUUSD_MAX_TOTAL_VOLUME_LOTS", 0.20)),
        max_spread_usd=max(0.0, _float(e, "XAUUSD_MAX_SPREAD_USD", 0.50)),
        sizing_mode=str(e.get("XAUUSD_SIZING_MODE", "RISK_PERCENT")).strip().upper() or "RISK_PERCENT",
        news_filter_enabled=_bool(e, "XAUUSD_NEWS_FILTER_ENABLED", True),
        news_file=Path(e.get("XAUUSD_NEWS_BLACKOUT_FILE") or DEFAULT_NEWS_FILE),
        news_before_min=max(0, _int(e, "XAUUSD_NEWS_BLACKOUT_BEFORE_MIN", 30)),
        news_after_min=max(0, _int(e, "XAUUSD_NEWS_BLACKOUT_AFTER_MIN", 30)),
        low_liquidity_filter_enabled=_bool(e, "XAUUSD_LOW_LIQUIDITY_FILTER_ENABLED", True),
        low_liquidity_windows=windows,
        kill_switch_env=_bool(e, "XAUUSD_KILL_SWITCH", False),
        kill_switch_file=Path(e.get("XAUUSD_KILL_SWITCH_FILE") or DEFAULT_KILL_SWITCH_FILE),
        max_clock_skew_sec=max(0.0, _float(e, "XAUUSD_MAX_CLOCK_SKEW_SEC", 5.0)),
        log_file=Path(e.get("XAUUSD_GUARD_LOG_FILE") or DEFAULT_LOG_FILE),
        entry_deviation_points=_clamp_int(e, "XAUUSD_ENTRY_DEVIATION_POINTS", 50, 1, HARD_MAX_ENTRY_DEVIATION_POINTS),
        close_deviation_points=_clamp_int(e, "XAUUSD_CLOSE_DEVIATION_POINTS", 50, 1, HARD_MAX_CLOSE_DEVIATION_POINTS),
    )


def _clamp_int(e: Mapping[str, str], key: str, default: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, _int(e, key, default)))


def deviation_points(kind: str, settings: GuardSettings | None = None) -> int:
    """Max price deviation (MT5 points) for an entry or a close request (AUDIT E-1, D-019).

    Entries are capped tighter (slippage on new risk); closes may use a wider value so
    risk reduction is not rejected in fast markets. Any read error falls back to 50.
    """
    try:
        s = settings or load_settings()
        return int(s.close_deviation_points if str(kind).lower() == "close" else s.entry_deviation_points)
    except Exception:
        return 50


# ---------------------------------------------------------------------------
# Execution mode
# ---------------------------------------------------------------------------

def execution_mode_block(action: str, *, real_account: bool, settings: GuardSettings) -> dict | None:
    """Return a blocking result for ``action`` under the current mode, or None."""
    action = str(action or "").lower()
    if action not in MUTATING_ACTIONS:
        return None
    if action == OPERATOR_FLATTEN_ACTION:
        # Explicit operator risk reduction is always permitted (see D-004).
        return None
    if settings.dry_run:
        return {
            "ok": False, "submitted": False, "dryRun": True,
            "status": "DRY_RUN_NO_BROKER_MUTATION",
            "message": "XAUUSD_DRY_RUN=true (default): no broker mutation was sent.",
        }
    if real_account and action in NEW_RISK_ACTIONS and not settings.live_confirmed:
        return {
            "ok": False, "submitted": False,
            "status": "BLOCKED_LIVE_NOT_CONFIRMED",
            "message": "REAL account: new exposure requires XAUUSD_LIVE=true AND XAUUSD_CONFIRM_LIVE=yes.",
        }
    return None


# ---------------------------------------------------------------------------
# Kill switch
# ---------------------------------------------------------------------------

def kill_switch_active(settings: GuardSettings) -> tuple[bool, str | None]:
    if settings.kill_switch_env:
        return True, "KILL_SWITCH_ENV"
    try:
        if settings.kill_switch_file.exists():
            return True, "KILL_SWITCH_FILE"
    except OSError:
        return True, "KILL_SWITCH_FILE_UNREADABLE_FAIL_CLOSED"
    return False, None


def activate_kill_switch(settings: GuardSettings, reason: str, *, flatten: bool = False, now: float | None = None) -> dict:
    payload = {
        "active": True,
        "reason": str(reason or "operator")[:200],
        "flattenRequested": bool(flatten),
        "activatedAtUtc": int(time.time() if now is None else now),
    }
    settings.kill_switch_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = settings.kill_switch_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, settings.kill_switch_file)
    return payload


def deactivate_kill_switch(settings: GuardSettings) -> bool:
    try:
        settings.kill_switch_file.unlink()
        return True
    except FileNotFoundError:
        return False


# ---------------------------------------------------------------------------
# Position sizing / exposure
# ---------------------------------------------------------------------------

def floor_to_step(volume: float, step: float) -> float:
    if step <= 0:
        raise ValueError("volume step must be positive")
    steps = floor(volume / step + 1e-9)
    text = f"{step:.8f}".rstrip("0")
    decimals = len(text.split(".")[1]) if "." in text else 0
    return round(steps * step, decimals)


def compute_risk_volume(
    *,
    equity: float,
    risk_pct: float,
    loss_per_lot_usd: float,
    volume_min: float,
    volume_step: float,
    volume_max: float,
) -> float | None:
    """Largest broker-valid lot whose SL loss is <= ``equity * risk_pct``.

    ``loss_per_lot_usd`` is the positive USD loss of 1.00 lot if the SL is hit
    (including any safety buffer). Returns None when even ``volume_min``
    exceeds the budget or inputs are invalid (fail closed).
    """
    vals = (equity, risk_pct, loss_per_lot_usd, volume_min, volume_step, volume_max)
    if not all(isinstance(v, (int, float)) and isfinite(float(v)) for v in vals):
        return None
    if equity <= 0 or risk_pct <= 0 or loss_per_lot_usd <= 0 or volume_min <= 0 or volume_step <= 0 or volume_max < volume_min:
        return None
    budget = equity * risk_pct / 100.0
    raw = budget / loss_per_lot_usd
    vol = min(floor_to_step(raw, volume_step), volume_max)
    vol = floor_to_step(vol, volume_step)
    if vol + 1e-12 < volume_min:
        return None
    return vol


def check_exposure_limits(
    positions: Iterable[Any],
    new_volume: float,
    settings: GuardSettings,
) -> dict | None:
    rows = list(positions or [])
    total = 0.0
    for p in rows:
        try:
            v = float(getattr(p, "volume", None) if not isinstance(p, dict) else p.get("volume"))
        except (TypeError, ValueError):
            return {"status": "BLOCKED_PORTFOLIO_RISK_UNVERIFIED", "message": "Cannot verify open-position inventory (portfolio volume unreadable)"}
        if not isfinite(v) or v < 0:
            return {"status": "BLOCKED_PORTFOLIO_RISK_UNVERIFIED", "message": "Cannot verify open-position inventory (portfolio volume invalid)"}
        total += v
    if len(rows) + 1 > settings.max_open_positions:
        return {
            "status": "BLOCKED_MAX_OPEN_POSITIONS",
            "message": f"Open positions {len(rows)} + 1 > limit {settings.max_open_positions}",
        }
    if total + float(new_volume) > settings.max_total_volume_lots + 1e-9:
        return {
            "status": "BLOCKED_MAX_TOTAL_VOLUME",
            "message": f"Total volume {total + float(new_volume):.2f} lots > limit {settings.max_total_volume_lots:.2f}",
        }
    return None


def check_spread(bid: float, ask: float, settings: GuardSettings) -> dict | None:
    try:
        bid_f, ask_f = float(bid), float(ask)
    except (TypeError, ValueError):
        return {"status": "BLOCKED_INVALID_QUOTE", "message": "Quote unreadable"}
    if not (isfinite(bid_f) and isfinite(ask_f)) or bid_f <= 0 or ask_f < bid_f:
        return {"status": "BLOCKED_INVALID_QUOTE", "message": "Invalid bid/ask"}
    spread = ask_f - bid_f
    if spread > settings.max_spread_usd + 1e-9:
        return {
            "status": "BLOCKED_SPREAD_TOO_WIDE",
            "message": f"Spread {spread:.2f} USD/oz > limit {settings.max_spread_usd:.2f}",
        }
    return None


# ---------------------------------------------------------------------------
# Loss limits
# ---------------------------------------------------------------------------

def week_start_utc(now_utc: float, broker_offset_hours: float = 0.0) -> float:
    """Monday 00:00 in broker-server time, expressed as a UTC timestamp."""
    offset = float(broker_offset_hours) * 3600.0
    shifted = now_utc + offset
    day_start = (int(shifted) // 86400) * 86400
    weekday = _dt.datetime.fromtimestamp(day_start, tz=_dt.timezone.utc).weekday()  # Monday=0
    return float(day_start - weekday * 86400 - offset)


def realized_trading_pnl(deals: Iterable[Any], since_utc: float, broker_offset_hours: float = 0.0) -> float:
    """Sum profit+commission+swap+fee of BUY/SELL deals (type 0/1) since ``since_utc``.

    MT5 deal ``time`` is broker-server time; it is converted with the
    verified broker offset. Balance/credit deals (type >= 2) are excluded.
    """
    offset = float(broker_offset_hours) * 3600.0
    total = 0.0
    for d in deals or []:
        get = (lambda k, d=d: d.get(k)) if isinstance(d, dict) else (lambda k, d=d: getattr(d, k, None))
        dtype = int(get("type") if get("type") is not None else -1)
        if dtype not in (0, 1):
            continue
        t = float(get("time") or 0) - offset
        if t < since_utc:
            continue
        for k in ("profit", "commission", "swap", "fee"):
            v = get(k)
            if v is None:
                continue
            fv = float(v)
            if not isfinite(fv):
                raise ValueError("non-finite deal amount")
            total += fv
    return total


def check_weekly_loss(
    *,
    deals: Iterable[Any] | None,
    balance: float,
    equity: float,
    now_utc: float,
    broker_offset_hours: float | None,
    settings: GuardSettings,
    new_order_risk_usd: float = 0.0,
) -> dict:
    if broker_offset_hours is None:
        return {"ok": False, "status": "BLOCKED_WEEKLY_HISTORY_UNVERIFIED", "message": "Broker UTC offset unverified"}
    if deals is None:
        return {"ok": False, "status": "BLOCKED_WEEKLY_HISTORY_UNVERIFIED", "message": "MT5 deal history unavailable"}
    try:
        start = week_start_utc(now_utc, broker_offset_hours)
        realized = realized_trading_pnl(deals, start, broker_offset_hours)
        balance_f, equity_f = float(balance), float(equity)
    except (TypeError, ValueError):
        return {"ok": False, "status": "BLOCKED_WEEKLY_HISTORY_UNVERIFIED", "message": "Deal history invalid"}
    week_start_balance = balance_f - realized
    if not isfinite(week_start_balance) or week_start_balance <= 0:
        return {"ok": False, "status": "BLOCKED_WEEKLY_HISTORY_UNVERIFIED", "message": "Week start balance invalid"}
    floating = min(0.0, equity_f - balance_f)
    loss_now = max(0.0, -(realized + floating))
    limit_usd = week_start_balance * settings.max_weekly_loss_pct / 100.0
    state = {
        "weekStartUtc": int(start),
        "weekStartBalanceUsd": round(week_start_balance, 2),
        "weeklyRealizedPnlUsd": round(realized, 2),
        "weeklyLossUsd": round(loss_now, 2),
        "weeklyLossLimitUsd": round(limit_usd, 2),
        "maxWeeklyLossPct": settings.max_weekly_loss_pct,
    }
    if loss_now >= limit_usd - 1e-9:
        return {"ok": False, "status": "BLOCKED_WEEKLY_LOSS_LIMIT", "message": "Weekly loss limit reached", **state}
    if loss_now + max(0.0, float(new_order_risk_usd)) > limit_usd + 1e-9:
        return {"ok": False, "status": "BLOCKED_WEEKLY_LOSS_LIMIT", "message": "New order risk would exceed weekly loss budget", **state}
    return {"ok": True, **state}


# ---------------------------------------------------------------------------
# Calendar filters
# ---------------------------------------------------------------------------

def _parse_iso_utc(value: str) -> float:
    text = str(value).strip().replace("Z", "+00:00")
    parsed = _dt.datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError("timestamp must carry an explicit UTC offset")
    return parsed.timestamp()


def load_news_calendar(path: Path) -> tuple[list[dict], float | None, str | None]:
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return [], None, "NEWS_CALENDAR_MISSING"
    except (OSError, ValueError):
        return [], None, "NEWS_CALENDAR_INVALID"
    if not isinstance(raw, dict) or not isinstance(raw.get("events"), list):
        return [], None, "NEWS_CALENDAR_INVALID"
    try:
        valid_until = _parse_iso_utc(raw["validUntil"])
        events = []
        for ev in raw["events"]:
            events.append({
                "name": str(ev.get("name") or "EVENT")[:80],
                "timeUtc": _parse_iso_utc(ev["timeUtc"]),
                "beforeMin": ev.get("beforeMin"),
                "afterMin": ev.get("afterMin"),
            })
    except (KeyError, TypeError, ValueError, AttributeError):
        return [], None, "NEWS_CALENDAR_INVALID"
    return events, valid_until, None


def check_news_blackout(now_utc: float, settings: GuardSettings, calendar: tuple[list[dict], float | None, str | None] | None = None) -> dict | None:
    if not settings.news_filter_enabled:
        return None
    events, valid_until, err = calendar if calendar is not None else load_news_calendar(settings.news_file)
    if err:
        return {"status": "BLOCKED_NEWS_CALENDAR_UNAVAILABLE", "message": f"{err}: maintain {settings.news_file} or set XAUUSD_NEWS_FILTER_ENABLED=false"}
    if valid_until is None or now_utc > valid_until:
        return {"status": "BLOCKED_NEWS_CALENDAR_EXPIRED", "message": "News calendar validUntil has passed; update it"}
    for ev in events:
        before = float(ev["beforeMin"] if ev.get("beforeMin") is not None else settings.news_before_min) * 60.0
        after = float(ev["afterMin"] if ev.get("afterMin") is not None else settings.news_after_min) * 60.0
        if ev["timeUtc"] - before <= now_utc <= ev["timeUtc"] + after:
            return {"status": "BLOCKED_NEWS_BLACKOUT", "message": f"High-impact news window: {ev['name']}"}
    return None


def check_low_liquidity(now_utc: float, settings: GuardSettings) -> dict | None:
    if not settings.low_liquidity_filter_enabled:
        return None
    t = _dt.datetime.fromtimestamp(now_utc, tz=_dt.timezone.utc)
    minute = t.hour * 60 + t.minute
    wd = t.weekday()
    if wd >= 5:
        return {"status": "BLOCKED_LOW_LIQUIDITY", "message": "Weekend: market closed / illiquid"}
    if wd == 4 and minute >= settings.friday_close_utc_min:
        return {"status": "BLOCKED_LOW_LIQUIDITY", "message": "Friday close window"}
    if wd == 0 and minute < settings.monday_open_utc_min:
        return {"status": "BLOCKED_LOW_LIQUIDITY", "message": "Monday open window"}
    for start, end in settings.low_liquidity_windows:
        inside = (start <= minute < end) if start <= end else (minute >= start or minute < end)
        if inside:
            return {"status": "BLOCKED_LOW_LIQUIDITY", "message": "Daily rollover / low-liquidity window"}
    return None


def check_clock_skew(tick_utc: float | None, now_utc: float, settings: GuardSettings) -> dict | None:
    if tick_utc is None:
        return None
    try:
        ahead = float(tick_utc) - float(now_utc)
    except (TypeError, ValueError):
        return {"status": "BLOCKED_CLOCK_UNVERIFIED", "message": "Tick time unreadable"}
    if not isfinite(ahead):
        return {"status": "BLOCKED_CLOCK_UNVERIFIED", "message": "Tick time invalid"}
    if ahead > settings.max_clock_skew_sec:
        return {
            "status": "BLOCKED_CLOCK_SKEW",
            "message": f"Broker tick is {ahead:.1f}s ahead of local clock; sync Windows time (w32tm /resync)",
        }
    return None


# ---------------------------------------------------------------------------
# Combined pre-trade evaluation (pure)
# ---------------------------------------------------------------------------

@dataclass
class PreTradeInput:
    real_account: bool
    equity: float
    requested_volume: float
    loss_per_lot_usd: float
    volume_min: float
    volume_step: float
    volume_max: float
    bid: float
    ask: float
    open_positions: list = field(default_factory=list)
    now_utc: float = 0.0
    tick_utc: float | None = None


def evaluate_pre_trade(inp: PreTradeInput, settings: GuardSettings, *, news_calendar=None) -> dict:
    """Return {"ok": bool, "status", "message", "volume"} for a new entry.

    ``volume`` is the (possibly reduced) lot to send. It is never larger than
    ``requested_volume``.
    """
    mode_block = execution_mode_block("order", real_account=inp.real_account, settings=settings)
    if mode_block:
        return {**mode_block, "volume": 0.0}
    active, why = kill_switch_active(settings)
    if active:
        return {"ok": False, "submitted": False, "status": "BLOCKED_KILL_SWITCH", "message": why, "volume": 0.0}
    for check in (
        lambda: check_clock_skew(inp.tick_utc, inp.now_utc, settings),
        lambda: check_spread(inp.bid, inp.ask, settings),
        lambda: check_news_blackout(inp.now_utc, settings, news_calendar),
        lambda: check_low_liquidity(inp.now_utc, settings),
    ):
        res = check()
        if res:
            return {"ok": False, "submitted": False, "volume": 0.0, **res}

    volume = float(inp.requested_volume)
    sized = compute_risk_volume(
        equity=inp.equity,
        risk_pct=settings.risk_per_trade_pct,
        loss_per_lot_usd=inp.loss_per_lot_usd,
        volume_min=inp.volume_min,
        volume_step=inp.volume_step,
        volume_max=inp.volume_max,
    )
    if sized is None:
        return {
            "ok": False, "submitted": False, "volume": 0.0,
            "status": "BLOCKED_RISK_PER_TRADE",
            "message": f"Minimum lot risk exceeds {settings.risk_per_trade_pct:.2f}% of equity at this SL",
        }
    adjusted = False
    if settings.sizing_mode == "RISK_PERCENT":
        if volume > sized + 1e-9:
            volume = sized
            adjusted = True
    elif volume > sized + 1e-9:
        # FIXED_LOT keeps the requested lot, but never above the hard risk cap.
        return {
            "ok": False, "submitted": False, "volume": 0.0,
            "status": "BLOCKED_RISK_PER_TRADE",
            "message": f"Fixed lot {volume} exceeds {settings.risk_per_trade_pct:.2f}% risk (max {sized})",
        }
    exposure = check_exposure_limits(inp.open_positions, volume, settings)
    if exposure:
        return {"ok": False, "submitted": False, "volume": 0.0, **exposure}
    return {
        "ok": True,
        "status": "GO_LIVE_GUARD_PASS",
        "volume": volume,
        "riskSizedVolume": sized,
        "volumeReducedToRiskCap": adjusted,
        "riskBudgetUsd": round(inp.equity * settings.risk_per_trade_pct / 100.0, 2),
    }


# ---------------------------------------------------------------------------
# Logging, alerts, heartbeat (never log secrets or full account numbers)
# ---------------------------------------------------------------------------

_SECRET_KEYS = re.compile(r"(pass(word)?|token|secret|api[_-]?key|authorization|otp)", re.IGNORECASE)
_ACCOUNT_KEYS = re.compile(r"(login|account(login)?|chat_?id)$", re.IGNORECASE)
_TELEGRAM_TOKEN_RE = re.compile(r"\b\d{6,12}:[A-Za-z0-9_-]{30,}\b")


def mask_account(value: Any) -> str:
    text = str(value or "")
    if len(text) <= 3:
        return "***"
    return "***" + text[-3:]


def redact(obj: Any) -> Any:
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            ks = str(k)
            if _SECRET_KEYS.search(ks):
                out[ks] = "[REDACTED]"
            elif _ACCOUNT_KEYS.search(ks):
                out[ks] = mask_account(v)
            else:
                out[ks] = redact(v)
        return out
    if isinstance(obj, (list, tuple)):
        return [redact(v) for v in obj]
    if isinstance(obj, str):
        return _TELEGRAM_TOKEN_RE.sub("[REDACTED_TOKEN]", obj)
    return obj


def log_event(event: str, payload: Mapping[str, Any] | None = None, *, settings: GuardSettings | None = None, now: float | None = None) -> None:
    """Append one structured JSON line. Never raises (logging must not trade)."""
    s = settings or load_settings()
    try:
        s.log_file.parent.mkdir(parents=True, exist_ok=True)
        record = {"ts": int((time.time() if now is None else now) * 1000), "event": str(event), **redact(dict(payload or {}))}
        with open(s.log_file, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    except Exception:
        pass


def send_alert(
    event: str,
    text: str,
    *,
    env: Mapping[str, str] | None = None,
    dedupe_key: str | None = None,
    dedupe_window_sec: int = 900,
    state_file: Path = DEFAULT_ALERT_STATE_FILE,
    transport: Callable[[str, bytes], Any] | None = None,
    now: float | None = None,
) -> bool:
    """Best-effort Telegram alert. Token/chat id come only from env/.env.

    Returns True if a message was handed to the transport. Never raises.
    """
    e = _env(env)
    if _bool(e, "XAUUSD_ALERTS_DISABLED", False):
        return False
    token = str(e.get("TELEGRAM_BOT_TOKEN") or "").strip()
    chat = str(e.get("TELEGRAM_CHAT_ID") or "").strip()
    if not token:
        legacy = str(os.environ.get("ZIQ_TELEGRAM_BOT_TOKEN") or "").strip() if env is None else ""
        token = "" if legacy.startswith("AES256GCM:") else legacy
    if not chat and env is None:
        chat = str(os.environ.get("ZIQ_TELEGRAM_CHAT_ID") or "").strip()
    if not token or not chat:
        return False
    current = time.time() if now is None else now
    key = dedupe_key or event
    try:
        state = json.loads(state_file.read_text(encoding="utf-8")) if state_file.exists() else {}
    except Exception:
        state = {}
    if current - float(state.get(key, 0) or 0) < dedupe_window_sec:
        return False
    body = urllib.parse.urlencode({
        "chat_id": chat,
        "text": f"[XAUUSD V6] {event}\n{redact(str(text))}"[:3500],
        "disable_web_page_preview": "true",
    }).encode("utf-8")
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        if transport is not None:
            transport(url, body)
        else:
            req = urllib.request.Request(url, data=body, method="POST")
            urllib.request.urlopen(req, timeout=3).read()
        state[key] = current
        state_file.parent.mkdir(parents=True, exist_ok=True)
        state_file.write_text(json.dumps(state), encoding="utf-8")
        return True
    except Exception:
        return False


def write_heartbeat(status: Mapping[str, Any], *, path: Path = DEFAULT_HEARTBEAT_FILE, now: float | None = None) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"tsUtc": int(time.time() if now is None else now), **redact(dict(status))}
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    except Exception:
        pass


def heartbeat_age_sec(path: Path = DEFAULT_HEARTBEAT_FILE, now: float | None = None) -> float | None:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return float((time.time() if now is None else now) - float(data["tsUtc"]))
    except Exception:
        return None


def retry_with_backoff(fn: Callable[[], Any], *, attempts: int = 3, base_delay: float = 1.0, max_delay: float = 8.0,
                       is_success: Callable[[Any], bool] = bool, sleep: Callable[[float], None] = time.sleep) -> Any:
    """Retry an idempotent operation (connect / read). NEVER use for order_send."""
    result = None
    for i in range(max(1, attempts)):
        result = fn()
        if is_success(result):
            return result
        if i < attempts - 1:
            sleep(min(max_delay, base_delay * (2 ** i)))
    return result
