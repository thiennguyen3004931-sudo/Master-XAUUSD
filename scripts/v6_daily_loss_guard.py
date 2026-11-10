"""Fail-closed V6 account-wide UTC intraday loss veto for NEW broker orders.

This is an additional source-only gate, not a LIVE authorization. It reads only
MT5 deal history, account equity and broker positions; it never sends orders.
It intentionally blocks when a trustworthy UTC-day PnL baseline cannot be
derived, including overnight exposure and unexplained account cash flows.

The cap is fixed at 2% of verified estimated UTC-day-start equity and cannot
be increased by a browser, order config or DCA request.
"""
from __future__ import annotations

from datetime import datetime, timezone
from math import isfinite
from pathlib import Path
import os
import time

MAX_DAILY_LOSS_PERCENT = 2.0
DEFAULT_EMERGENCY_HALT = (
    Path(__file__).resolve().parents[1] / ".runtime" / "v6-halt-new-orders.flag"
)


def _blocked(message):
    return {"allowed": False, "message": "V6 new order blocked: " + message}


def _finite_number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (ValueError, TypeError, OverflowError):
        return None
    return number if isfinite(number) else None


def verify_daily_new_order_budget(
    mt5, account, existing_positions, projected_sl_risk,
    *, now_utc_seconds=None, emergency_halt_path=None,
):
    """Veto entry/DCA unless today's account loss and projected SL are provable.

    Closed trade profit, commission, swap and fee from UTC 00:00 through now
    plus floating profit/swap on positions opened today are included.
    If a position or closing deal may span the day boundary, refuse to invent
    its midnight equity baseline. Only NEW risk is vetoed; existing positions
    must still be managed and closable through their separate guarded paths.
    """
    if os.environ.get("V6_HALT_NEW_ORDERS", "").strip().lower() in ("1", "true", "yes", "on"):
        return _blocked("emergency halt environment flag is active")
    halt_path = Path(emergency_halt_path) if emergency_halt_path is not None else DEFAULT_EMERGENCY_HALT
    try:
        if halt_path.exists() or halt_path.is_symlink():
            return _blocked("emergency halt marker is present")
    except OSError:
        return _blocked("emergency halt marker state cannot be read")

    risk = _finite_number(projected_sl_risk)
    equity = _finite_number(getattr(account, "equity", None))
    stamp = _finite_number(time.time() if now_utc_seconds is None else now_utc_seconds)
    if risk is None or risk <= 0 or equity is None or equity <= 0 or stamp is None or stamp <= 0:
        return _blocked("invalid broker equity, time or projected SL risk")
    if existing_positions is None:
        return _blocked("broker position inventory is unavailable")

    start_seconds = int(stamp // 86400) * 86400
    start = datetime.fromtimestamp(start_seconds, tz=timezone.utc)
    end = datetime.fromtimestamp(stamp, tz=timezone.utc)
    try:
        history_query = getattr(mt5, "history_deals_get", None)
        if not callable(history_query):
            return _blocked("broker UTC-day deal history API is unavailable")
        deals = history_query(start, end)
    except Exception:
        return _blocked("broker UTC-day deal history query failed")
    if deals is None:
        return _blocked("broker UTC-day deal history is unverified")

    allowed_types = {
        int(getattr(mt5, "DEAL_TYPE_BUY", 0)),
        int(getattr(mt5, "DEAL_TYPE_SELL", 1)),
    }
    entry_in = int(getattr(mt5, "DEAL_ENTRY_IN", 0))
    entry_out = int(getattr(mt5, "DEAL_ENTRY_OUT", 1))
    entry_out_by = int(getattr(mt5, "DEAL_ENTRY_OUT_BY", 3))
    realized = 0.0
    opened_today = set()
    closed_today = set()
    try:
        for deal in deals:
            kind = int(getattr(deal, "type", -1))
            if kind not in allowed_types:
                # Deposits, withdrawals, corrections, fee adjustments or any
                # non-trade cash flow invalidate the equity reconstruction.
                return _blocked("intraday non-trading ledger item requires review")
            occurred = _finite_number(getattr(deal, "time", None))
            if occurred is None or not start_seconds <= occurred <= stamp + 60:
                return _blocked("broker deal history time is inconsistent")
            entry = int(getattr(deal, "entry", -1))
            pos_id = int(getattr(deal, "position_id", 0))
            if pos_id <= 0 or entry not in (entry_in, entry_out, entry_out_by):
                return _blocked("broker deal lifecycle cannot be reconstructed")
            if entry == entry_in:
                opened_today.add(pos_id)
            else:
                closed_today.add(pos_id)
            for name in ("profit", "commission", "swap", "fee"):
                value = _finite_number(getattr(deal, name, None))
                if value is None:
                    return _blocked("broker deal monetary fields are incomplete")
                realized += value
        if not closed_today.issubset(opened_today):
            return _blocked("overnight closed-position PnL baseline is unverified")
    except (TypeError, ValueError, OverflowError, AttributeError):
        return _blocked("broker deal history records are invalid")

    floating = 0.0
    try:
        for position in existing_positions:
            opened = _finite_number(getattr(position, "time", None))
            if opened is None or not start_seconds <= opened <= stamp + 60:
                return _blocked("overnight or unknown-age position needs midnight equity evidence")
            profit = _finite_number(getattr(position, "profit", None))
            swap = _finite_number(getattr(position, "swap", 0.0))
            if profit is None or swap is None:
                return _blocked("broker open-position PnL is incomplete")
            floating += profit + swap
    except (TypeError, ValueError, OverflowError, AttributeError):
        return _blocked("broker position inventory is invalid")

    intraday_pnl = realized + floating
    baseline_equity = equity - intraday_pnl
    if not isfinite(intraday_pnl) or not isfinite(baseline_equity) or baseline_equity <= 0:
        return _blocked("UTC-day equity baseline cannot be reconstructed")

    loss_limit = baseline_equity * MAX_DAILY_LOSS_PERCENT / 100.0
    if intraday_pnl <= -loss_limit:
        return _blocked("daily account loss limit reached")
    if intraday_pnl - risk <= -loss_limit:
        return _blocked("new order could exceed daily account loss limit at SL")

    return {
        "allowed": True,
        "message": "Account-level UTC daily-loss and projected SL veto passed",
    }
