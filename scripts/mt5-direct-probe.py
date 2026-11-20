#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
XAUUSD AI MASTER — BỘ THỰC THI & KẾT NỐI TRỰC TIẾP MT5 TOÀN DIỆN (DIRECT MT5 ENGINE V6)
Kiến trúc Fail-Closed (P0/P1 Deep Audit Remediation):
1. Xác thực tài khoản MT5 (Login, Server, Account Mode, Terminal Connected) bắt buộc kể cả khi để trống mật khẩu.
2. Kiểm tra độ mới dữ liệu giá (Tick Freshness) chuẩn UTC.
3. Cổng Quản trị Rủi ro & Thực thi chung (Execution Gateway):
   - Quy ước 1 giá = 1.00 USD/oz (phân biệt với point của broker).
   - Ngay trước order_send: lấy quote mới, kiểm tra lại SL 6.0–8.0 USD/oz ngoài cấu trúc vô hiệu hóa (nếu > 8.0 USD/oz -> trả WAIT_PULLBACK, tuyệt đối không ép SL vào trong cấu trúc; nếu < 6.0 USD/oz -> chỉ nới ra 6.0 khi hợp lệ và tính lại toàn bộ rủi ro + R:R).
   - Trần 1.0% rủi ro/lệnh, 1.5% tổng danh mục (vị thế mở + lệnh chờ + lệnh mới/DCA).
   - Giới hạn lỗ ngày tính trực tiếp từ lịch sử deal MT5 (profit + commission + swap + fee), lưu mốc vốn đầu ngày và trạng thái chạm trần bền vững qua restart, không tính trùng lỗ thả nổi và rủi ro SL đang mở.
   - Đối soát sau khớp lệnh (giá khớp, khối lượng, SL/TP thực tế trên MT5); ghi nhận sai lệch và khóa DCA khi chưa xử lý, không tự nới SL.
4. Bộ Quản lý Vị thế Dùng chung (evaluate_position_management_step) cho cả Live và Backtest:
   - Lưu bền vững theo account/server/ticket: actualEntry, initialSl, initialR (không bao giờ tính lại từ SL đã dời), cực trị thuận lợi (peak).
   - BE mặc định tại 1R (loại bỏ hoàn toàn ngưỡng 4.5 giá của DCA), có bù chi phí thực tế (phân biệt BE_NET và BE_NOMINAL).
   - Trailing cấu trúc M5 đã đóng cả trước và sau BE; khóa cực trị M15 cách 10 giá; giữ nguyên TP hợp lệ.
5. Backtest Engine đồng nhất 100% với chạy thật:
   - Không look-ahead bias, không tự đóng sau 96 nến M5, tách riêng vị thế đang mở cuối kỳ (OPEN_AT_DATASET_END).
   - Xử lý đúng Bid/Ask cho BUY/SELL, trừ spread/commission/slippage/swap công khai.
   - Chia dữ liệu theo thời gian: In-Sample (50%), Validation (25%), Out-of-Sample (25%) + Walk-Forward.
   - Tách riêng Win Rate, Breakeven Rate và Loss Rate (không gộp Thắng + BE thành Win Rate).
"""
import sys
import os
import json
import time
import uuid
import threading
from contextlib import contextmanager
import datetime
import subprocess
from pathlib import Path
from math import isfinite, floor
from xauusd_v6_trade_rules import (
    evaluate_entry,
    classify_market_regime,
    select_tp_with_near_obstacle_check,
    structural_stop,
    trail_stop,
    peak_profit_stop,
    is_m15_fast_move,
    evaluate_position_management_step,
    closed,
    MIN_STRUCTURAL_SL_DIST,
    MAX_STRUCTURAL_SL_DIST,
    CANDLE_LOOKBACK_BARS,
    DEFAULT_ROUND_TRIP_COST_PTS,
)

HARD_MAX_RISK_PER_TRADE_PCT = 1.0
HARD_MAX_PORTFOLIO_RISK_PCT = 1.5
DEFAULT_MAX_QUOTE_AGE_SEC = 60.0
DEFAULT_MAX_DAILY_LOSS_PCT = 3.0
DEFAULT_MAX_DRAWDOWN_PCT = 6.0
ONE_PRICE_UNIT_USD_PER_OZ = 1.0

RUNTIME_DIR = Path(__file__).resolve().parent.parent / ".runtime"
MANAGER_STATE_FILE = RUNTIME_DIR / "v6-position-manager-state.json"
DAILY_RISK_STATE_FILE = RUNTIME_DIR / "v6-daily-risk-state.json"
REGIME_STATE_FILE = RUNTIME_DIR / "v6-regime-state.json"


def ensure_mt5_installed():
    try:
        import MetaTrader5 as mt5
        return mt5, None
    except ImportError:
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "--quiet", "MetaTrader5"],
                timeout=45
            )
            import MetaTrader5 as mt5
            return mt5, None
        except Exception as e:
            return None, f"Chưa cài gói Python MetaTrader5 ({e}). Hãy mở CMD chạy: pip install MetaTrader5"


def detect_running_terminal_path():
    if os.name != "nt":
        return None
    try:
        out = subprocess.check_output(
            ["powershell", "-NoProfile", "-Command",
             "(Get-Process terminal64 -ErrorAction SilentlyContinue | Select-Object -First 1).Path"],
            timeout=4,
            stderr=subprocess.DEVNULL
        ).decode("utf-8", errors="ignore").strip()
        if out and os.path.exists(out):
            return out
    except Exception:
        pass
    common_paths = [
        r"C:\Program Files\DBG Markets MetaTrader 5\terminal64.exe",
        r"C:\Program Files\DBG Markets MT5 Terminal\terminal64.exe",
        r"C:\Program Files\MetaTrader 5\terminal64.exe",
        r"C:\Program Files (x86)\MetaTrader 5\terminal64.exe",
    ]
    for p in common_paths:
        if os.path.exists(p):
            return p
    return None


def verify_mt5_account_binding(mt5, config, account=None, terminal=None):
    """Fail-closed verification of MT5 terminal connection, account login, server, and trade mode.
    Blank password NEVER bypasses account login/server/mode verification.
    """
    cfg = config or {}
    if terminal is None and callable(getattr(mt5, "terminal_info", None)):
        try:
            terminal = mt5.terminal_info()
        except Exception:
            terminal = None
    if terminal is not None and getattr(terminal, "connected", True) is False:
        return False, "MT5 terminal is disconnected from broker server"

    if account is None and callable(getattr(mt5, "account_info", None)):
        try:
            account = mt5.account_info()
        except Exception:
            account = None
    if account is None:
        return False, "Cannot read MT5 account_info(); terminal not logged in"

    login_raw = str(cfg.get("login") or cfg.get("expectedLogin") or "").strip()
    server_raw = str(cfg.get("server") or cfg.get("expectedServer") or "").strip()
    expected_mode = str(cfg.get("accountMode") or cfg.get("expectedAccountMode") or "").strip().upper()

    if login_raw:
        if not login_raw.isdigit():
            return False, f"Configured MT5 login '{login_raw}' is not a valid numeric account ID"
        actual_login = int(getattr(account, "login", 0) or 0)
        if actual_login != int(login_raw):
            return (
                False,
                f"MT5 account login mismatch: connected #{actual_login} != configured #{login_raw} "
                f"(blank password does not bypass account binding)"
            )

    if server_raw:
        actual_server = str(getattr(account, "server", "") or "").strip()
        EXPLICIT_SERVER_ALIAS_MAP = {
            "dbgmarkets-live": "dbgmarkets-live",
            "dbg market limited": "dbgmarkets-live",
            "dbgmarkets-demo": "dbgmarkets-demo",
            "dbg market limited demo": "dbgmarkets-demo",
        }
        act_canon = EXPLICIT_SERVER_ALIAS_MAP.get(actual_server.lower(), actual_server.lower())
        exp_canon = EXPLICIT_SERVER_ALIAS_MAP.get(server_raw.lower(), server_raw.lower())
        if not actual_server or (act_canon != exp_canon):
            return (
                False,
                f"MT5 server mismatch: connected '{actual_server}' != configured '{server_raw}'"
            )

    if expected_mode in ("DEMO", "LIVE", "REAL"):
        trade_mode = int(getattr(account, "trade_mode", 0) or 0)
        real_const = int(getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2))
        demo_const = int(getattr(mt5, "ACCOUNT_TRADE_MODE_DEMO", 0))
        actual_mode = "LIVE" if trade_mode == real_const else ("DEMO" if trade_mode == demo_const else "CONTEST")
        norm_expected = "LIVE" if expected_mode in ("LIVE", "REAL") else "DEMO"
        if actual_mode != norm_expected:
            return (
                False,
                f"MT5 account mode mismatch: connected account is {actual_mode}, configured mode is {norm_expected}"
            )

    return True, None


def verify_tick_freshness_utc(tick, max_age_sec=DEFAULT_MAX_QUOTE_AGE_SEC, now_utc=None, broker_utc_offset_hours=0.0):
    """Verify MT5 tick freshness strictly in UTC using explicit deterministic broker offset (no 2h/3h guessing)."""
    if tick is None:
        return False, 999999.0, "Missing MT5 tick"
    tick_ts = float(getattr(tick, "time", 0) or 0)
    if not isfinite(tick_ts) or tick_ts <= 0:
        return False, 999999.0, "Invalid or nonpositive UTC tick timestamp"
    now_sec = float(time.time() if now_utc is None else now_utc)
    offset_sec = float(broker_utc_offset_hours or 0.0) * 3600.0
    tick_utc = tick_ts - offset_sec
    quote_age = now_sec - tick_utc
    max_allowed = max(1.0, float(max_age_sec or DEFAULT_MAX_QUOTE_AGE_SEC))
    if not isfinite(quote_age) or quote_age < -10.0 or quote_age > max_allowed:
        return (
            False,
            quote_age,
            f"Stale or out-of-sync UTC quote ({quote_age:.1f}s age; allowed [-10.0s, {max_allowed:.1f}s])"
        )
    return True, quote_age, None


def verify_live_execution_gate(mt5, account, terminal, cfg):
    """Independent fail-closed gate for REAL/LIVE accounts.
    Requires explicit multi-gate flags AND verified account/terminal binding.
    """
    if account is None or terminal is None:
        return False, "Missing account or terminal info for LIVE gate"
    # LIVE connectivity must be explicitly reported as true; missing or
    # ambiguous terminal state is not proof of a connected broker session.
    if getattr(terminal, "connected", None) is not True:
        return False, "Terminal connectivity unverified; LIVE gate rejected"
    if not bool(getattr(terminal, "trade_allowed", False)) or not bool(getattr(account, "trade_expert", False)):
        return False, "Algo/Expert trading disabled in MT5; LIVE gate rejected"
    ok_bind, bind_err = verify_mt5_account_binding(mt5, cfg, account=account, terminal=terminal)
    if not ok_bind:
        return False, f"LIVE gate account binding failed: {bind_err}"
    if not (
        cfg.get("liveAuthorized") is True
        and cfg.get("liveArmed") is True
        and cfg.get("explicitLiveGateConfirmed") is True
    ):
        return False, "Explicit multi-gate LIVE authorization not granted (fail-closed)"
    # When supplied, both ARM identifiers must match the connected broker
    # session. Never ignore armedServer or raise on malformed ARM inputs.
    armed_login = str(cfg.get("armedAccountLogin") or "").strip()
    if armed_login:
        if not armed_login.isdigit():
            return False, "ARM session login is invalid"
        try:
            actual_login = int(getattr(account, "login", None))
        except (TypeError, ValueError, OverflowError):
            return False, "ARM broker login unverified"
        if actual_login != int(armed_login):
            return False, "ARM session login does not match connected broker account"
    armed_server = str(cfg.get("armedServer") or "").strip()
    if armed_server:
        actual_server = str(getattr(account, "server", "") or "").strip()
        if not actual_server or actual_server.casefold() != armed_server.casefold():
            return False, "ARM session server does not match connected broker server"
    return True, None


@contextmanager
def _cross_process_file_lock(file_path):
    lock_path = Path(str(file_path) + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fh = open(lock_path, "a+", encoding="utf-8")
    try:
        try:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        except ImportError:
            try:
                import msvcrt
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_LOCK, 1)
            except Exception:
                pass
        yield
    finally:
        try:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        except ImportError:
            try:
                import msvcrt
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
            except Exception:
                pass
        fh.close()


class _EntryExecutionLockUnavailable(Exception):
    """Only raised when OS-level entry-lock acquisition fails."""


# Serialize the entire new-order read/check/send/reconcile transaction.
# A global runtime lock is intentionally stricter than account-scoped locking:
# it prevents two local execution gateways from racing on the same broker.
_ENTRY_GATE_THREAD_LOCK = threading.Lock()


@contextmanager
def _strict_new_order_lock():
    """Fail closed if the OS cannot acquire an exclusive cross-process lock."""
    lock_path = RUNTIME_DIR / "v6-new-order-execution.lock"
    with _ENTRY_GATE_THREAD_LOCK:
        try:
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            fh = open(lock_path, "a+b")
        except OSError as exc:
            raise _EntryExecutionLockUnavailable(str(exc)) from exc
        try:
            if os.name == "nt":
                try:
                    import msvcrt
                    fh.seek(0)
                    if fh.read(1) == b"":
                        fh.seek(0)
                        fh.write(b"\\x00")
                        fh.flush()
                    fh.seek(0)
                    msvcrt.locking(fh.fileno(), msvcrt.LK_LOCK, 1)
                except (OSError, ImportError) as exc:
                    raise _EntryExecutionLockUnavailable(str(exc)) from exc
                try:
                    yield
                finally:
                    fh.seek(0)
                    msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                try:
                    import fcntl
                    fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
                except (OSError, ImportError) as exc:
                    raise _EntryExecutionLockUnavailable(str(exc)) from exc
                try:
                    yield
                finally:
                    fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        finally:
            fh.close()


def _load_json_state_unlocked(file_path):
    try:
        return json.loads(Path(file_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_json_state_unlocked(file_path, state):
    p = Path(file_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    temporary = p.with_name(f"{p.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, p)


def _load_json_state(file_path):
    with _cross_process_file_lock(file_path):
        return _load_json_state_unlocked(file_path)


def _save_json_state(file_path, state):
    with _cross_process_file_lock(file_path):
        _save_json_state_unlocked(file_path, state)


def _update_json_state(file_path, mutator_fn):
    with _cross_process_file_lock(file_path):
        state = _load_json_state_unlocked(file_path)
        if not isinstance(state, dict):
            state = {}
        new_state = mutator_fn(state)
        if new_state is None:
            new_state = state
        _save_json_state_unlocked(file_path, new_state)
        return new_state


def _load_manager_state():
    return _load_json_state(MANAGER_STATE_FILE)


def _save_manager_state(state):
    _save_json_state(MANAGER_STATE_FILE, state)


def _position_state_keys(account_login, server, ticket, symbol=""):
    t_str = str(int(ticket))
    login_str = str(account_login or "0").strip()
    srv_str = str(server or "DEFAULT").strip()
    sym_str = str(symbol or "").strip()
    if sym_str:
        return f"{login_str}|{srv_str}|{sym_str}|{t_str}", f"{login_str}|{srv_str}|{t_str}"
    return f"{login_str}|{srv_str}|{t_str}", f"{login_str}|{srv_str}|{t_str}"


def _safe_read_positions(mt5, symbol=None):
    try:
        res = mt5.positions_get(symbol=symbol) if symbol else mt5.positions_get()
        if not isinstance(res, (list, tuple)):
            return [], False, "MT5 positions_get() returned invalid inventory"
        return list(res), True, None
    except Exception as exc:
        return [], False, f"MT5 positions_get() raised: {exc}" 


def compute_and_persist_daily_loss_state(
    mt5,
    account,
    cfg,
    open_positions=None,
    open_sl_risk_usd=0.0,
    pending_sl_risk_usd=0.0,
    new_order_risk_usd=0.0,
    now_utc=None,
):
    """Section 1.3: Compute and persist daily loss state from MT5 deal history.
    - Day boundary: 00:00:00 in configured timezone (default UTC, offset=0.0h).
    - Sums trading deal profit + commission + swap + fee for all deals (type in (0, 1)) since day start.
    - Separates deposit/withdrawal deals (type == 2) so deposits never erase realized trading losses
      and withdrawals reduce effective baseline capital.
    - Persists dayStartBalanceUsd and dailyLimitBreached latch in `.runtime/v6-daily-risk-state.json`
      so server/MT5 restarts never reset the daily loss counter or clear a breach block.
    - Combines realized loss, floating loss, and open/new SL risk WITHOUT double-counting:
      For each open position i, its worst-case daily loss contribution is `max(floating_loss_i, sl_risk_from_open_i)`.
    """
    cfg_d = cfg or {}
    now_sec = float(time.time() if now_utc is None else now_utc)
    tz_offset_hours = float(cfg_d.get("dailyResetTimezoneOffsetHours") or 0.0)
    tz_offset_sec = tz_offset_hours * 3600.0
    shifted_now = int(now_sec + tz_offset_sec)
    day_start_shifted = (shifted_now // 86400) * 86400
    day_start_utc_ts = float(day_start_shifted - tz_offset_sec)
    day_key = datetime.datetime.fromtimestamp(day_start_shifted, tz=datetime.timezone.utc).strftime("%Y-%m-%d")

    login_id = int(getattr(account, "login", 0) or cfg_d.get("login") or 0)
    server_name = str(getattr(account, "server", "") or cfg_d.get("server") or "DEFAULT").strip()
    state_key = f"{login_id}|{server_name}|{day_key}"

    balance = float(getattr(account, "balance", 0.0) or 0.0)
    equity = float(getattr(account, "equity", balance) or balance)
    max_daily_loss_pct = max(0.5, min(5.0, float(cfg_d.get("maxDailyLossPercent") or DEFAULT_MAX_DAILY_LOSS_PCT)))

    all_daily_state = _load_json_state(DAILY_RISK_STATE_FILE)
    persisted = dict(all_daily_state.get(state_key, {}))

    has_deal_api = hasattr(mt5, "history_deals_get") and callable(getattr(mt5, "history_deals_get", None))
    realized_trading_net_pnl = 0.0
    net_cashflow_usd = 0.0
    deal_count_today = 0

    if has_deal_api:
        try:
            deals = mt5.history_deals_get(day_start_utc_ts - 14400.0, now_sec + 86400.0)
        except Exception as e:
            return {
                "ok": False,
                "reason": f"Cannot read MT5 deal history for daily loss check: {e} (fail-closed)",
            }
        if deals is None:
            return {
                "ok": False,
                "reason": "MT5 history_deals_get returned None; daily loss state unverified (fail-closed)",
            }
        for d in deals:
            raw_t = float(getattr(d, "time", 0) or 0)
            if raw_t <= 0:
                continue
            # Explicit deterministic broker server UTC offset (no heuristic 2h/3h guessing from now_sec)
            broker_offset_sec = float(cfg_d.get("brokerUtcOffsetHours") or 0.0) * 3600.0
            deal_utc = raw_t - broker_offset_sec
            if deal_utc < day_start_utc_ts:
                continue
            d_type = int(getattr(d, "type", -1))
            if d_type in (0, 1):
                # Trading deal (BUY/SELL): include profit, commission, swap, and fee
                d_net = (
                    float(getattr(d, "profit", 0.0) or 0.0)
                    + float(getattr(d, "commission", 0.0) or 0.0)
                    + float(getattr(d, "swap", 0.0) or 0.0)
                    + float(getattr(d, "fee", 0.0) or 0.0)
                )
                realized_trading_net_pnl += d_net
                deal_count_today += 1
            elif d_type == 2:
                # Balance operation (Deposit / Withdrawal)
                net_cashflow_usd += float(getattr(d, "profit", 0.0) or 0.0)
    else:
        # A saved loss latch or client-supplied number is not proof that today's
        # broker history is complete. Never authorize a new trade without the
        # broker's history API, irrespective of optional configuration flags.
        return {
            "ok": False,
            "reason": "MT5 deal history API unavailable; daily loss cannot be verified (fail-closed)",
        }

    realized_loss_from_deals = max(0.0, -realized_trading_net_pnl)
    cfg_supplied_loss = float(cfg_d.get("dailyRealizedLossUsd") or 0.0)
    prev_peak_loss = float(persisted.get("maxDailyLossRecordedUsd") or persisted.get("dailyRealizedLossUsd") or 0.0)

    # Current net realized loss today vs conservative high-water loss latch
    daily_realized_loss_usd = round(max(realized_loss_from_deals, cfg_supplied_loss), 2)
    max_daily_loss_recorded_usd = round(max(daily_realized_loss_usd, prev_peak_loss), 2)

    # Establish or restore start-of-day anchor balance
    if "dayStartBalanceUsd" in persisted and float(persisted.get("dayStartBalanceUsd") or 0) > 0:
        day_start_balance = float(persisted["dayStartBalanceUsd"])
    else:
        reconstructed = balance - realized_trading_net_pnl - net_cashflow_usd
        day_start_balance = round(reconstructed if reconstructed > 0 else balance, 2)

    # Deposits do not increase the daily loss budget; withdrawals reduce it
    effective_base_balance = max(0.01, day_start_balance + min(0.0, net_cashflow_usd))
    daily_loss_limit_usd = round(effective_base_balance * (max_daily_loss_pct / 100.0), 2)

    # Compute current floating loss and non-double-counted worst-case open position loss
    pos_floating_loss_sum = 0.0
    if open_positions:
        for p in open_positions:
            p_net_float = (
                float(getattr(p, "profit", 0.0) or 0.0)
                + float(getattr(p, "swap", 0.0) or 0.0)
                + float(getattr(p, "commission", 0.0) or 0.0)
            )
            pos_floating_loss_sum += max(0.0, -p_net_float)
    account_floating_loss = max(0.0, balance - equity)
    current_floating_loss_usd = round(max(account_floating_loss, pos_floating_loss_sum), 2)

    # Worst-case loss from existing open positions if all hit SL:
    # max(current_floating_loss_usd, open_sl_risk_usd) avoids double-counting floating loss + full SL distance from entry!
    worst_case_open_positions_loss_usd = round(max(current_floating_loss_usd, float(open_sl_risk_usd or 0.0)), 2)

    current_daily_loss_usd = round(daily_realized_loss_usd + current_floating_loss_usd, 2)
    max_daily_loss_recorded_usd = round(max(max_daily_loss_recorded_usd, current_daily_loss_usd), 2)
    projected_worst_case_daily_loss_usd = round(
        daily_realized_loss_usd
        + worst_case_open_positions_loss_usd
        + float(pending_sl_risk_usd or 0.0)
        + float(new_order_risk_usd or 0.0),
        2,
    )

    was_breached = bool(persisted.get("dailyLimitBreached", False))
    now_breached = was_breached or (daily_loss_limit_usd > 0 and current_daily_loss_usd >= daily_loss_limit_usd - 1e-6)
    would_exceed_with_new_order = now_breached or (
        daily_loss_limit_usd > 0 and projected_worst_case_daily_loss_usd > daily_loss_limit_usd + 1e-6
    )

    updated_record = {
        "accountLogin": login_id,
        "server": server_name,
        "dayKey": day_key,
        "timezoneRule": f"UTC{tz_offset_hours:+.1f}h (00:00 reset)",
        "dayStartUtcTs": int(day_start_utc_ts),
        "dayStartBalanceUsd": round(day_start_balance, 2),
        "effectiveBaseBalanceUsd": round(effective_base_balance, 2),
        "netCashflowUsd": round(net_cashflow_usd, 2),
        "dealCountToday": deal_count_today,
        "dailyRealizedNetPnlUsd": round(realized_trading_net_pnl, 2),
        "dailyRealizedLossUsd": daily_realized_loss_usd,
        "maxDailyLossRecordedUsd": max_daily_loss_recorded_usd,
        "currentFloatingLossUsd": current_floating_loss_usd,
        "worstCaseOpenPositionsLossUsd": worst_case_open_positions_loss_usd,
        "pendingOrdersRiskUsd": round(float(pending_sl_risk_usd or 0.0), 2),
        "newOrderRiskUsd": round(float(new_order_risk_usd or 0.0), 2),
        "currentDailyLossUsd": current_daily_loss_usd,
        "projectedWorstCaseDailyLossUsd": projected_worst_case_daily_loss_usd,
        "maxDailyLossPercent": max_daily_loss_pct,
        "dailyLossLimitUsd": daily_loss_limit_usd,
        "dailyLimitBreached": now_breached,
        "wouldExceedWithNewOrder": would_exceed_with_new_order,
        "updatedAtUtc": int(now_sec),
    }
    def _save_daily(s):
        s[state_key] = updated_record
        return s
    _update_json_state(DAILY_RISK_STATE_FILE, _save_daily)

    return {
        "ok": True,
        **updated_record,
    }


def connect_mt5(mt5, config):
    cfg = config or {}
    user_path = str(cfg.get("terminalPath") or "").strip()
    login_raw = str(cfg.get("login") or "").strip()
    password = str(cfg.get("password") or "").strip()
    server = str(cfg.get("server") or "").strip()

    initialized = False
    try:
        initialized = bool(mt5.initialize())
    except Exception:
        initialized = False

    if not initialized:
        target_path = user_path if (user_path and os.path.exists(user_path)) else detect_running_terminal_path()
        if target_path:
            try:
                initialized = bool(mt5.initialize(path=target_path))
            except Exception:
                initialized = False

    if not initialized:
        last_err = mt5.last_error() if callable(getattr(mt5, "last_error", None)) else "init_failed"
        return False, f"Không kết nối được cửa sổ MT5 ({last_err}). Hãy mở phần mềm MetaTrader 5 trên máy tính!"

    account = mt5.account_info()
    if password and login_raw.isdigit() and server:
        if account is None or int(getattr(account, "login", 0) or 0) != int(login_raw):
            ok_login = mt5.login(login=int(login_raw), password=password, server=server)
            if not ok_login:
                last_err = mt5.last_error() if callable(getattr(mt5, "last_error", None)) else "login_failed"
                return False, f"Đăng nhập TK #{login_raw} tại '{server}' thất bại ({last_err})."
            account = mt5.account_info()

    ok_bind, bind_err = verify_mt5_account_binding(mt5, cfg, account=account)
    if not ok_bind:
        return False, bind_err

    return True, None


def resolve_gold_symbol(mt5, preferred_symbol="XAUUSD.G"):
    all_syms = mt5.symbols_get() or []
    gold_candidates = []
    for s in all_syms:
        name = str(getattr(s, "name", ""))
        up = name.upper()
        if "XAUUSD" in up or up.startswith("GOLD"):
            gold_candidates.append(name)

    priority = [
        preferred_symbol,
        "XAUUSD.G",
        "XAUUSD.g",
        "XAUUSD",
        "XAUUSDm",
        "XAUUSDc",
        "XAUUSD.r",
        "GOLD",
    ]
    for cand in priority:
        cand = (cand or "").strip()
        if not cand:
            continue
        info = mt5.symbol_info(cand)
        if info is not None:
            if not getattr(info, "visible", False):
                mt5.symbol_select(cand, True)
            return cand, gold_candidates[:12]

    if gold_candidates:
        first = gold_candidates[0]
        mt5.symbol_select(first, True)
        return first, gold_candidates[:12]

    return preferred_symbol or "XAUUSD.G", []


def resolve_filling_mode(mt5, sym_info):
    mode = int(getattr(sym_info, "filling_mode", 0) or 0)
    if mode & 1:
        return int(getattr(mt5, "ORDER_FILLING_FOK", 0))
    if mode & 2:
        return int(getattr(mt5, "ORDER_FILLING_IOC", 1))
    return int(getattr(mt5, "ORDER_FILLING_RETURN", 2))


def analyze_live_candles(candles, candles_h1=None, candles_h4=None):
    if not candles or len(candles) < 8:
        return {
            "patternId": "RANGE_BOX",
            "patternName": "12. Hộp Tích Lũy Nén Biên Độ (Đang thu thập nến M15)",
            "signalSide": "WAIT",
            "trendAligned": False,
            "setupScore": 75,
            "confidence": 75,
            "scoreType": "HEURISTIC_POINTS_OUT_OF_100",
            "atr": 4.5,
            "reason": "Cần tối thiểu 8 nến M15 đã đóng để đánh giá mẫu hình thời gian thực."
        }
    closed_bars = candles[:-1] if len(candles) > 10 else candles
    ranges = [abs(c[1] - c[2]) for c in closed_bars[-14:]]
    atr_val = round(sum(ranges) / max(1, len(ranges)), 2)
    atr_val = max(1.5, atr_val)

    c1 = closed_bars[-2]
    c2 = closed_bars[-1]

    o1, h1, l1, cl1 = c1[0], c1[1], c1[2], c1[3]
    o2, h2, l2, cl2 = c2[0], c2[1], c2[2], c2[3]

    body1 = cl1 - o1
    body2 = cl2 - o2
    rng2 = max(0.01, h2 - l2)
    lower_wick2 = min(o2, cl2) - l2
    upper_wick2 = h2 - max(o2, cl2)

    closed_closes = [c[3] for c in closed_bars]
    ema10 = calc_ema(closed_closes, min(10, len(closed_closes)))
    ema25 = calc_ema(closed_closes, min(25, len(closed_closes)))

    h1_bear = False
    h1_bull = False
    h1_flat = False
    if candles_h1 and len(candles_h1) >= 12:
        h1_cl = [c[3] for c in candles_h1[:-1]]
        e10_h1 = calc_ema(h1_cl, min(10, len(h1_cl)))
        e25_h1 = calc_ema(h1_cl, min(25, len(h1_cl)))
        h1_rng = sum(abs(c[1] - c[2]) for c in candles_h1[-14:]) / min(14, len(candles_h1))
        if abs(e10_h1 - e25_h1) <= 0.45 * max(1.0, h1_rng):
            h1_flat = True
        elif e10_h1 < e25_h1 and h1_cl[-1] <= e10_h1:
            h1_bear = True
        elif e10_h1 > e25_h1 and h1_cl[-1] >= e10_h1:
            h1_bull = True

    price_below_both_emas = (cl2 < ema10 and cl2 < ema25)
    price_above_both_emas = (cl2 > ema10 and cl2 > ema25)
    is_bear_trend = price_below_both_emas or (not price_above_both_emas and (h1_bear or (ema10 < ema25 and cl2 <= ema25)))
    ema_gap_ratio = abs(ema10 - ema25) / max(0.5, atr_val)

    prior8 = closed_bars[-9:-1] if len(closed_bars) >= 9 else closed_bars[:-1]
    old_low8 = min(b[2] for b in prior8) if prior8 else l2
    old_high8 = max(b[1] for b in prior8) if prior8 else h2

    recent20 = closed_bars[-20:]
    box_w = (max(b[1] for b in recent20) - min(b[2] for b in recent20)) if recent20 else 99.0
    if h1_flat and box_w <= 4.2 * atr_val and ema_gap_ratio < 0.35:
        return {
            "patternId": "RANGE_BOX",
            "patternName": "12. Hộp Tích Lũy Nén Biên Độ (Sideway Range)",
            "signalSide": "NEUTRAL",
            "trendAligned": False,
            "setupScore": 86,
            "confidence": 86,
            "scoreType": "HEURISTIC_POINTS_OUT_OF_100",
            "atr": atr_val,
            "ema10": ema10,
            "ema25": ema25,
            "reason": f"Khung H1 phẳng, giá đi ngang trong hộp 20 nến M15 rộng {box_w:.1f} giá (ATR ${atr_val}) · Chờ phản ứng tại 2 biên."
        }

    if is_bear_trend:
        if (h2 > old_high8 and cl2 < old_high8) or (upper_wick2 / rng2 >= 0.45 and cl2 <= o2):
            wick_pct = upper_wick2 / rng2
            dyn_conf = min(94, max(86, int(round(86 + wick_pct * 8.0 + min(3.0, ema_gap_ratio * 2.0)))))
            return {
                "patternId": "BEAR_SWEEP_UPTHRUST",
                "patternName": "7. Quét Thanh Khoản Đỉnh (Upthrust)",
                "signalSide": "SELL",
                "trendAligned": True,
                "setupScore": dyn_conf,
                "confidence": dyn_conf,
                "scoreType": "HEURISTIC_POINTS_OUT_OF_100",
                "atr": atr_val,
                "ema10": ema10,
                "ema25": ema25,
                "reason": f"Nến M15 quét đỉnh cũ ({h2}) rồi rút râu đóng giảm tại {cl2} thuận xu hướng Giảm (EMA10 {ema10} < EMA25 {ema25}, điểm setup {dyn_conf}/100)."
            }
        recent12 = closed_bars[-12:]
        highs12 = [b[1] for b in recent12]
        lows12 = [b[2] for b in recent12]
        h_first = max(highs12[:4]) if len(highs12) >= 12 else h2
        h_mid = max(highs12[4:8]) if len(highs12) >= 12 else h2
        h_last = max(highs12[8:]) if len(highs12) >= 12 else h2
        l_first = min(lows12[:6]) if len(lows12) >= 12 else l2
        l_last = min(lows12[6:]) if len(lows12) >= 12 else l2

        if h_mid > h_first + 0.6 and h_mid > h_last + 0.6 and cl2 < ema10:
            dyn_conf = min(93, max(86, int(round(87 + min(4.0, ema_gap_ratio * 2.5)))))
            return {
                "patternId": "BEAR_HS_TOP",
                "patternName": "8. Vai Đầu Vai Đỉnh (H&S Top)",
                "signalSide": "SELL",
                "trendAligned": True,
                "setupScore": dyn_conf,
                "confidence": dyn_conf,
                "scoreType": "HEURISTIC_POINTS_OUT_OF_100",
                "atr": atr_val,
                "ema10": ema10,
                "ema25": ema25,
                "reason": f"Cấu trúc Đỉnh Đầu ({h_mid}) cao hơn 2 Vai ({h_first} / {h_last}), giá ({cl2}) nằm dưới EMA10 ({ema10}) thuận trend Giảm."
            }
        if abs(h_first - h_last) <= 0.45 * atr_val and cl2 < (h_last - 0.8 * atr_val):
            dyn_conf = min(92, max(85, int(round(86 + min(4.0, ema_gap_ratio * 2.2)))))
            return {
                "patternId": "BEAR_DOUBLE_TOP",
                "patternName": "9. Hai Đỉnh Đảo Chiều (Double Top)",
                "signalSide": "SELL",
                "trendAligned": True,
                "setupScore": dyn_conf,
                "confidence": dyn_conf,
                "scoreType": "HEURISTIC_POINTS_OUT_OF_100",
                "atr": atr_val,
                "ema10": ema10,
                "ema25": ema25,
                "reason": f"2 lần chạm vùng cung ({h_first} – {h_last}) bị từ chối giảm về {cl2} dưới EMA25 ({ema25})."
            }
        if h_last < h_mid <= h_first and abs(l_first - l_last) <= 0.6 * atr_val:
            dyn_conf = min(91, max(85, int(round(85 + min(4.0, ema_gap_ratio * 2.2)))))
            return {
                "patternId": "BEAR_DESC_TRIANGLE",
                "patternName": "11. Tam Giác Giảm (Descending)",
                "signalSide": "SELL",
                "trendAligned": True,
                "setupScore": dyn_conf,
                "confidence": dyn_conf,
                "scoreType": "HEURISTIC_POINTS_OUT_OF_100",
                "atr": atr_val,
                "ema10": ema10,
                "ema25": ema25,
                "reason": f"Đỉnh M15 hạ thấp dần ({h_first} → {h_mid} → {h_last}) ép sát hỗ trợ {l_last} trong xu hướng Giảm."
            }
        body_ratio = abs(body2) / rng2
        dyn_conf = min(93, max(85, int(round(85 + body_ratio * 4.0 + min(4.0, ema_gap_ratio * 2.2)))))
        return {
            "patternId": "BEAR_PENNANT",
            "patternName": "10. Cờ Giảm Tiếp Diễn (Bearish Flag)",
            "signalSide": "SELL",
            "trendAligned": True,
            "setupScore": dyn_conf,
            "confidence": dyn_conf,
            "scoreType": "HEURISTIC_POINTS_OUT_OF_100",
            "atr": atr_val,
            "ema10": ema10,
            "ema25": ema25,
            "reason": f"Sóng giảm chủ đạo (EMA10 {ema10} < EMA25 {ema25}) kèm nhịp tích lũy Cờ Giảm tại {cl2} · Ưu tiên canh SELL (điểm setup {dyn_conf}/100)."
        }

    if (l2 < old_low8 and cl2 > old_low8) or (lower_wick2 / rng2 >= 0.45 and cl2 >= o2):
        wick_pct = lower_wick2 / rng2
        dyn_conf = min(94, max(86, int(round(86 + wick_pct * 8.0 + min(3.0, ema_gap_ratio * 2.0)))))
        return {
            "patternId": "BULL_SWEEP_PINBAR",
            "patternName": "1. Quét Thanh Khoản Đáy + Pinbar",
            "signalSide": "BUY",
            "trendAligned": True,
            "setupScore": dyn_conf,
            "confidence": dyn_conf,
            "scoreType": "HEURISTIC_POINTS_OUT_OF_100",
            "atr": atr_val,
            "ema10": ema10,
            "ema25": ema25,
            "reason": f"Râu dưới quét đáy cũ ({l2}) rồi rút chân đóng tăng tại {cl2} thuận xu hướng Tăng (EMA10 {ema10} ≥ EMA25 {ema25}, điểm setup {dyn_conf}/100)."
        }

    recent12 = closed_bars[-12:]
    highs12 = [b[1] for b in recent12]
    lows12 = [b[2] for b in recent12]
    l_first = min(lows12[:4]) if len(lows12) >= 12 else l2
    l_mid = min(lows12[4:8]) if len(lows12) >= 12 else l2
    l_last = min(lows12[8:]) if len(lows12) >= 12 else l2
    h_first = max(highs12[:6]) if len(highs12) >= 12 else h2
    h_last = max(highs12[6:]) if len(highs12) >= 12 else h2

    if l_mid < l_first - 0.6 and l_mid < l_last - 0.6 and cl2 >= ema10:
        dyn_conf = min(93, max(86, int(round(87 + min(4.0, ema_gap_ratio * 2.5)))))
        return {
            "patternId": "BULL_IHS",
            "patternName": "2. Vai Đầu Vai Ngược (Inverse H&S)",
            "signalSide": "BUY",
            "trendAligned": True,
            "setupScore": dyn_conf,
            "confidence": dyn_conf,
            "scoreType": "HEURISTIC_POINTS_OUT_OF_100",
            "atr": atr_val,
            "ema10": ema10,
            "ema25": ema25,
            "reason": f"Cấu trúc 3 đáy với đáy giữa sâu nhất ({l_mid}), giá ({cl2}) bứt lên trên EMA10 ({ema10})."
        }
    if abs(l_first - l_last) <= 0.45 * atr_val and cl2 > (l_last + 0.8 * atr_val):
        dyn_conf = min(92, max(85, int(round(86 + min(4.0, ema_gap_ratio * 2.2)))))
        return {
            "patternId": "BULL_DOUBLE_BOTTOM",
            "patternName": "3. Hai Đáy Đảo Chiều (Double Bottom)",
            "signalSide": "BUY",
            "trendAligned": True,
            "setupScore": dyn_conf,
            "confidence": dyn_conf,
            "scoreType": "HEURISTIC_POINTS_OUT_OF_100",
            "atr": atr_val,
            "ema10": ema10,
            "ema25": ema25,
            "reason": f"Kiểm định vùng cầu ({l_first} – {l_last}) 2 lần không thủng, bật tăng lên {cl2}."
        }
    if l_last > l_mid >= l_first and abs(h_first - h_last) <= 0.6 * atr_val:
        dyn_conf = min(91, max(85, int(round(85 + min(4.0, ema_gap_ratio * 2.2)))))
        return {
            "patternId": "BULL_ASC_TRIANGLE",
            "patternName": "6. Tam Giác Tăng (Ascending)",
            "signalSide": "BUY",
            "trendAligned": True,
            "setupScore": dyn_conf,
            "confidence": dyn_conf,
            "scoreType": "HEURISTIC_POINTS_OUT_OF_100",
            "atr": atr_val,
            "ema10": ema10,
            "ema25": ema25,
            "reason": f"Đáy M15 nâng cao dần ({l_first} → {l_mid} → {l_last}) ép sát kháng cự {h_last} thuận xu hướng Tăng."
        }

    body_ratio = abs(body2) / rng2
    dyn_conf = min(93, max(85, int(round(85 + body_ratio * 4.0 + min(4.0, ema_gap_ratio * 2.2)))))
    return {
        "patternId": "BULL_FLAG",
        "patternName": "4. Cờ Tăng Tiếp Diễn (Bullish Flag)",
        "signalSide": "BUY",
        "trendAligned": True,
        "setupScore": dyn_conf,
        "confidence": dyn_conf,
        "scoreType": "HEURISTIC_POINTS_OUT_OF_100",
        "atr": atr_val,
        "ema10": ema10,
        "ema25": ema25,
        "reason": f"Sóng tăng chủ đạo (EMA10 {ema10} ≥ EMA25 {ema25}) kèm kênh Cờ Tăng tại {cl2} · Ưu tiên canh BUY (điểm setup {dyn_conf}/100)."
    }


def fetch_tf_candles(mt5, symbol, tf_const, count=CANDLE_LOOKBACK_BARS):
    out = []
    try:
        rates = mt5.copy_rates_from_pos(symbol, tf_const, 0, count)
        if rates is not None:
            for r in rates:
                out.append([
                    round(float(r["open"]), 2),
                    round(float(r["high"]), 2),
                    round(float(r["low"]), 2),
                    round(float(r["close"]), 2),
                    int(r["time"]) * 1000,
                ])
    except Exception:
        pass
    return out


def calc_ema(values, period):
    if not values:
        return 0.0
    k = 2.0 / (period + 1.0)
    ema_val = float(values[0])
    for v in values[1:]:
        ema_val = float(v) * k + ema_val * (1.0 - k)
    return round(ema_val, 2)


def analyze_multi_timeframe_h4_h1_m15(candles_h4, candles_h1, candles_m15, live_analysis, current_price, entry_signal=None):
    p = round(float(current_price or 4678.96), 2)
    es = entry_signal or {}
    market_regime = str(es.get("marketRegime") or "UNKNOWN")

    if candles_h4 and len(candles_h4) >= 10:
        closes_h4 = [c[3] for c in candles_h4]
        highs_h4 = [c[1] for c in candles_h4[-12:]]
        lows_h4 = [c[2] for c in candles_h4[-12:]]
        ema34_h4 = calc_ema(closes_h4, min(34, len(closes_h4)))
        ema89_h4 = calc_ema(closes_h4, min(89, len(closes_h4)))
        swing_high_h4 = round(max(highs_h4), 2)
        swing_low_h4 = round(min(lows_h4), 2)
        es_h4 = es.get("h4Bias")
        if es_h4 == "NEUTRAL":
            h4_bull = None
            h4_bias = "TRUNG TÍNH / ĐI NGANG (Neutral H4)"
        else:
            h4_bull = (es_h4 == "BUY") if es_h4 in ("BUY", "SELL") else (p >= ema34_h4)
            h4_bias = "TĂNG CHỦ ĐẠO (Bullish Structure)" if h4_bull else "GIẢM CHỦ ĐẠO (Bearish Structure)"
    else:
        ema34_h4 = round(p - 6.5, 2)
        ema89_h4 = round(p - 18.2, 2)
        swing_high_h4 = round(p + 24.0, 2)
        swing_low_h4 = round(p - 21.0, 2)
        h4_bull = True
        h4_bias = "TĂNG CHỦ ĐẠO (Trên EMA34/89 H4)"

    if candles_h1 and len(candles_h1) >= 10:
        closes_h1 = [c[3] for c in candles_h1]
        highs_h1 = [c[1] for c in candles_h1[-10:]]
        lows_h1 = [c[2] for c in candles_h1[-10:]]
        ema34_h1 = calc_ema(closes_h1, min(34, len(closes_h1)))
        swing_high_h1 = round(max(highs_h1), 2)
        swing_low_h1 = round(min(lows_h1), 2)
        es_h1 = es.get("h1Bias")
        if es_h1 == "NEUTRAL":
            h1_bull = None
            h1_bias = "TRUNG TÍNH / PHẲNG (Flat H1 Range)"
        else:
            h1_bull = (es_h1 == "BUY") if es_h1 in ("BUY", "SELL") else (p >= ema34_h1)
            h1_bias = "ĐỒNG PHA TĂNG (Giữ trên vùng Cầu H1)" if h1_bull else "ĐỒNG PHA GIẢM (Dưới vùng Cung H1)"
    else:
        ema34_h1 = round(p - 3.8, 2)
        swing_high_h1 = round(p + 11.5, 2)
        swing_low_h1 = round(p - 9.5, 2)
        h1_bull = True
        h1_bias = "ĐỒNG PHA TĂNG (Cấu trúc đáy cao dần)"

    demand_low = round(max(swing_low_h1, p - 6.5), 2)
    demand_high = round(demand_low + 2.8, 2)
    supply_high = round(min(swing_high_h1, p + 9.5), 2)
    supply_low = round(supply_high - 2.8, 2)

    es_side = es.get("side")
    es_pref = es.get("preferredSide")
    if es_side in ("BUY", "SELL"):
        m15_side = es_side
    elif es_pref in ("BUY", "SELL", "NEUTRAL"):
        m15_side = es_pref
    else:
        m15_side = "NEUTRAL"

    m15_pat = str(live_analysis.get("patternName") or "12. Hộp Tích Lũy Nén Biên Độ")
    if m15_side == "SELL" and ("Tăng" in m15_pat or "Bullish" in m15_pat):
        m15_pat = "10. Cờ Giảm Tiếp Diễn (Bearish Flag)"
    elif m15_side == "BUY" and ("Giảm" in m15_pat or "Bearish" in m15_pat):
        m15_pat = "4. Cờ Tăng Tiếp Diễn (Bullish Flag)"
    elif m15_side == "NEUTRAL":
        m15_pat = "12. Trạng thái Trung Tính / Chuyển Tiếp (Đứng ngoài NO_TRADE)"

    m15_score = int(es.get("setupScore") or live_analysis.get("setupScore") or live_analysis.get("confidence") or 85)
    m15_atr = float(live_analysis.get("atr") or 4.5)

    is_buy_plan = (m15_side != "SELL")
    entry_low = round(p - 1.2 if is_buy_plan else p - 0.5, 2)
    entry_high = round(p + 0.5 if is_buy_plan else p + 1.2, 2)
    plan_sl_dist = max(MIN_STRUCTURAL_SL_DIST, min(MAX_STRUCTURAL_SL_DIST, round(m15_atr * 1.25, 2)))
    sl_price = round(float(es.get("sl") or (p - plan_sl_dist if is_buy_plan else p + plan_sl_dist)), 2)
    actual_r = round(abs(p - sl_price), 2) or 6.8
    be_price = round(p + actual_r if is_buy_plan else p - actual_r, 2)
    tp1_price = round(p + round(actual_r * 1.6, 2) if is_buy_plan else p - round(actual_r * 1.6, 2), 2)
    tp2_price = round(float(es.get("tp") or (p + round(actual_r * 2.2, 2) if is_buy_plan else p - round(actual_r * 2.2, 2))), 2)

    now_sec = int(time.time())
    next_15m_boundary = ((now_sec // 900) + 1) * 900
    rem_sec = max(5, next_15m_boundary - now_sec)

    rec_bot_map = {
        "TREND_UP": "Bot 3: Thuận Xu Hướng & Quét Thanh Khoản (BUY)",
        "TREND_DOWN": "Bot 3: Thuận Xu Hướng & Quét Thanh Khoản (SELL)",
        "RANGE": "Bot 4: Giao Dịch Biên Độ Ngang (Tắt DCA)",
        "TRANSITION": "NO_TRADE (Chuyển tiếp — Đứng ngoài)",
        "UNKNOWN": "NO_TRADE (Chưa đủ dữ liệu nến đóng)",
    }

    return {
        "updatedAt": int(time.time() * 1000),
        "nextUpdateInSec": rem_sec,
        "currentPrice": p,
        "marketRegime": market_regime,
        "h4": {
            "timeframe": "H4",
            "bias": h4_bias,
            "isBull": bool(h4_bull),
            "ema34": ema34_h4,
            "ema89": ema89_h4,
            "swingHigh": swing_high_h4,
            "swingLow": swing_low_h4,
            "summary": f"Giá ({p}) vs EMA34 H4 ({ema34_h4}) · Biên H4: {swing_low_h4} – {swing_high_h4}."
        },
        "h1": {
            "timeframe": "H1",
            "bias": h1_bias,
            "isBull": bool(h1_bull),
            "ema34": ema34_h1,
            "demandZone": f"{demand_low} – {demand_high}",
            "supplyZone": f"{supply_low} – {supply_high}",
            "summary": f"EMA34 H1: {ema34_h1} · Vùng Cầu (Demand): {demand_low}–{demand_high} · Vùng Cung (Supply): {supply_low}–{supply_high}."
        },
        "m15": {
            "timeframe": "M15",
            "patternName": m15_pat,
            "signalSide": m15_side,
            "setupScore": m15_score,
            "confidence": m15_score,
            "scoreType": "HEURISTIC_POINTS_OUT_OF_100",
            "atr": m15_atr,
            "summary": f"Trạng thái: {market_regime} · Mẫu nến: {m15_pat} (Điểm setup: {m15_score}/100) · Hướng: {m15_side} · ATR(M15): ${m15_atr}."
        },
        "scenario15m": {
            "direction": m15_side,
            "marketRegime": market_regime,
            "title": (
                f"TRẠNG THÁI {market_regime}: ĐỨNG NGOÀI (NO_TRADE)"
                if m15_side == "NEUTRAL"
                else f"TRẠNG THÁI {market_regime}: THEO DÕI {m15_side} (SL 6–8 GIÁ & KIỂM TRA CẢN GẦN)"
            ),
            "recommendedBot": rec_bot_map.get(market_regime, "Bot 1: Tự Động Theo Trạng Thái Thị Trường"),
            "entryZone": f"{entry_low} – {entry_high}",
            "stopLoss": sl_price,
            "beTrigger": be_price,
            "tp1": tp1_price,
            "tp2": tp2_price,
            "tpSource": es.get("tpSource", "FALLBACK_FIXED_RR_OPEN_AIR"),
            "dcaCondition": f"Chỉ nhồi DCA Dương khi lệnh đầu ({p}) ĐÃ KÉO SL VỀ BE 1R ({be_price}), đang Dương, không có cảnh báo đối soát, tổng rủi ro <= 1.5% và có nến M15 mới đóng cùng chiều.",
            "invalidation": f"Nếu SL cấu trúc > 8.0 giá -> WAIT_PULLBACK; nếu vướng cản gần H1/H4 không đủ R:R ròng -> NO_TRADE."
        }
    }


def calc_structural_sl_6_to_8(candles_m15, candles_m5, side, entry_price):
    """Return the genuine structural stop distance within [6.0, 8.0] USD/oz or None; never clamp a too-wide stop."""
    stop = structural_stop(side, entry_price, candles_m5, candles_m15, max_distance=MAX_STRUCTURAL_SL_DIST)
    return round(abs(entry_price - stop), 2) if stop is not None else None


def calc_structural_sl_and_sr_tp(
    candles_m5,
    candles_m15,
    candles_h1,
    candles_h4,
    side,
    entry_price,
    fallback_sl_dist=6.8,
    fallback_tp_dist=16.0,
    min_rr=1.6,
    round_trip_cost=DEFAULT_ROUND_TRIP_COST_PTS,
):
    """Use structural M5/M15 stop strictly within [6.0, 8.0] USD/oz AND check near H1/H4 obstacles (Section 1.4 & 3.2):
    - Reject if structural SL > 8.0 USD/oz (WAIT_PULLBACK).
    - Reject if nearest opposing H1/H4 obstacle leaves net R:R < min_rr (NEAR_OBSTACLE_INSUFFICIENT_RR).
    """
    m5 = closed(candles_m5)
    m15 = closed(candles_m15)
    sl = structural_stop(side, entry_price, candles_m5, candles_m15, max_distance=MAX_STRUCTURAL_SL_DIST)
    if sl is None:
        return None
    ref_level = (min(b[2] for b in m5[-8:]) if side == "BUY" else max(b[1] for b in m5[-8:])) if len(m5) >= 8 else None
    sl_dist = round(abs(entry_price - sl), 2)
    sl_reason = f"SL cấu trúc 8 nến M5 ({sl_dist} giá, ngoài mốc {ref_level})"
    h1 = closed(candles_h1)
    h4 = closed(candles_h4)
    tp_sel = select_tp_with_near_obstacle_check(
        side,
        entry_price,
        sl,
        h1,
        h4,
        min_rr=min_rr,
        round_trip_cost=round_trip_cost,
        fallback_rr=max(2.2, round(float(fallback_tp_dist or 16.0) / max(0.01, sl_dist), 2)),
    )
    if not tp_sel.get("ok"):
        return None
    tp = tp_sel["tp"]
    tp_reason = tp_sel["tpReason"]
    return (
        sl_dist,
        sl,
        sl_reason,
        round(abs(tp - entry_price), 2),
        tp,
        tp_reason,
    )


def find_m5_structural_trail_sl(candles_m5, side, current_price, open_price, prior_sl=0.0):
    """Find confirmed M5 structural trailing stop both before BE and after BE."""
    confirmed = closed(candles_m5)
    return trail_stop(side, open_price, current_price, prior_sl, confirmed, current_price)


def partial_close_position(mt5, pos, close_ratio=0.5, comment_tag="PARTIAL_TP_H1_SR"):
    """Close no more than the requested broker-step volume; verify the actual remaining position."""
    try:
        ratio = float(close_ratio)
        ticket = int(pos.ticket)
        symbol = str(pos.symbol)
    except (TypeError, ValueError, AttributeError):
        return {"ok": False, "message": "Invalid partial-close request"}
    if not isfinite(ratio) or not 0.0 < ratio < 1.0:
        return {"ok": False, "message": "Partial-close ratio must be strictly between 0 and 1"}
    fresh = _read_position_by_ticket(mt5, ticket)
    if fresh is None or str(getattr(fresh, "symbol", "")) != symbol or int(getattr(fresh, "type", -1)) != int(pos.type):
        return {"ok": False, "message": f"Cannot verify current broker position #{ticket}"}
    info = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)
    if info is None or tick is None:
        return {"ok": False, "message": "Cannot read broker symbol or quote for partial close"}
    min_vol = float(getattr(info, "volume_min", 0) or 0)
    step = float(getattr(info, "volume_step", 0) or 0)
    current_vol = float(getattr(fresh, "volume", 0) or 0)
    if (not all(isfinite(v) and v > 0 for v in (min_vol, step, current_vol))
            or abs(current_vol / step - round(current_vol / step)) > 1e-6):
        return {"ok": False, "message": "Invalid or non-step broker position volume"}
    close_units = min(
        floor((current_vol * ratio + 1e-9) / step),
        floor((current_vol - min_vol + 1e-9) / step),
    )
    close_vol = round(close_units * step, 8)
    remaining_plan = round(current_vol - close_vol, 8)
    if close_vol < min_vol - 1e-9 or remaining_plan < min_vol - 1e-9:
        return {"ok": False, "message": "Broker minimum/step prevents safe partial close"}

    is_buy = int(fresh.type) == 0
    price = float(tick.bid if is_buy else tick.ask)
    if not isfinite(price) or price <= 0:
        return {"ok": False, "message": "Invalid broker quote for partial close"}
    request = {
        "action": int(getattr(mt5, "TRADE_ACTION_DEAL", 1)),
        "symbol": symbol,
        "position": ticket,
        "volume": close_vol,
        "type": int(getattr(mt5, "ORDER_TYPE_SELL", 1) if is_buy else getattr(mt5, "ORDER_TYPE_BUY", 0)),
        "price": price,
        "deviation": 50,
        "magic": int(getattr(fresh, "magic", 270715) or 270715),
        "comment": comment_tag[:31],
        "type_time": int(getattr(mt5, "ORDER_TIME_GTC", 0)),
        "type_filling": resolve_filling_mode(mt5, info),
    }
    result = mt5.order_send(request)
    if result is None or int(getattr(result, "retcode", -1)) not in (10009, 10010):
        return {"ok": False, "message": f"Broker rejected partial close #{ticket}"}

    after = _read_position_by_ticket(mt5, ticket)
    if after is None:
        return {"ok": False, "submitted": True, "uncertain": True,
                "message": f"Broker partial close #{ticket} acknowledged but remaining position unconfirmed"}
    after_vol = float(getattr(after, "volume", 0) or 0)
    actual_closed = round(current_vol - after_vol, 8)
    if (not isfinite(after_vol) or after_vol < min_vol - 1e-9
            or actual_closed < step / 2
            or actual_closed > close_vol + step / 2):
        return {"ok": False, "submitted": True, "uncertain": True,
                "message": f"Broker partial close #{ticket} acknowledged but volume readback inconsistent"}
    partial_fill = actual_closed < close_vol - step / 2
    return {
        "ok": True, "changed": True, "ticket": ticket,
        "closedVolume": actual_closed,
        "requestedCloseVolume": close_vol,
        "remainingVolume": round(after_vol, 8),
        "partialFill": partial_fill,
        "quotePrice": price,
        "message": f"Broker confirmed partial close #{ticket}: {actual_closed} lot closed; {round(after_vol, 8)} lot remaining" +
                   (" (partial broker fill)" if partial_fill else ""),
    }


def _read_position_by_ticket(mt5, ticket_id):
    try:
        positions = mt5.positions_get(ticket=int(ticket_id)) or []
        return next((p for p in positions if int(getattr(p, "ticket", 0)) == int(ticket_id)), None)
    except Exception:
        return None


def modify_position_sl_tp(mt5, pos, new_sl, new_tp, reason_label=""):
    """Never loosen a stop and never report broker confirmation without a readback."""
    sym = str(pos.symbol)
    current = _read_position_by_ticket(mt5, pos.ticket)
    if current is None or str(getattr(current, "symbol", "")) != sym or int(current.type) != int(pos.type):
        return {"ok": False, "changed": False, "message": "Cannot verify current broker ticket before SLTP"}
    sym_info = mt5.symbol_info(sym)
    tick = mt5.symbol_info_tick(sym)
    if sym_info is None or tick is None:
        return {"ok": False, "changed": False, "message": "Cannot verify broker symbol/quote"}
    digits = int(getattr(sym_info, "digits", 2))
    point = float(getattr(sym_info, "point", 0.01) or 0.01)
    cur_sl = round(float(getattr(current, "sl", 0.0) or 0.0), digits)
    cur_tp = round(float(getattr(current, "tp", 0.0) or 0.0), digits)
    sl_val = round(float(new_sl), digits) if new_sl is not None else cur_sl
    tp_val = round(float(new_tp), digits) if new_tp is not None else cur_tp
    buy = int(pos.type) == 0

    if sl_val <= 0:
        return {"ok": False, "changed": False, "message": "SL protection required"}
    if cur_sl > 0 and ((buy and sl_val < cur_sl - point / 2) or
                       (not buy and sl_val > cur_sl + point / 2)):
        return {"ok": False, "changed": False, "message": "Rejected: monotonic SL must not worsen risk"}
    if abs(sl_val - cur_sl) < point / 2 and abs(tp_val - cur_tp) < point / 2:
        return {"ok": True, "changed": False, "message": "SL/TP already at requested price"}

    freeze = float(getattr(sym_info, "trade_freeze_level", 0) or 0) * point
    stops = float(getattr(sym_info, "trade_stops_level", 0) or 0) * point
    min_gap = max(point, freeze, stops)
    executable_price = float(tick.bid if buy else tick.ask)
    if (buy and sl_val >= executable_price - min_gap) or (
        not buy and sl_val <= executable_price + min_gap
    ):
        return {"ok": False, "changed": False, "message": "Broker freeze/stops gap prevents protective SL move"}
    req = {
        "action": int(getattr(mt5, "TRADE_ACTION_SLTP", 6)),
        "symbol": sym,
        "position": int(pos.ticket),
        "sl": sl_val,
        "tp": tp_val,
    }
    result = mt5.order_send(req)
    if result is None or int(getattr(result, "retcode", -1)) not in (10009, 10025):
        return {"ok": False, "changed": False, "message": f"Broker rejected SLTP for #{pos.ticket}"}
    latest = _read_position_by_ticket(mt5, pos.ticket)
    if latest is None or abs(float(getattr(latest, "sl", 0.0) or 0.0) - sl_val) > point:
        return {"ok": False, "changed": False, "message": f"SLTP unconfirmed on ticket #{pos.ticket}"}
    if abs(tp_val - cur_tp) > point and abs(float(getattr(latest, "tp", 0.0) or 0.0) - tp_val) > point:
        return {"ok": False, "changed": False, "message": f"TP update unconfirmed on ticket #{pos.ticket}"}
    return {
        "ok": True, "changed": True, "ticket": int(pos.ticket),
        "sl": sl_val, "tp": tp_val,
        "message": f"Broker confirmed #{pos.ticket}: {reason_label} (SL {sl_val}, TP {tp_val})"
    }



def servers_match(server_a, server_b):
    alias_map = {
        "dbgmarkets-live": "dbgmarkets-live",
        "dbg market limited": "dbgmarkets-live",
        "dbgmarkets-demo": "dbgmarkets-demo",
        "dbg market limited demo": "dbgmarkets-demo",
    }
    a = str(server_a or "").strip().lower()
    b = str(server_b or "").strip().lower()
    if not a or not b:
        return False
    return alias_map.get(a, a) == alias_map.get(b, b)


def _is_manager_state_corrupted():
    try:
        if MANAGER_STATE_FILE.exists():
            raw = MANAGER_STATE_FILE.read_text(encoding="utf-8").strip()
            if not raw:
                return True
            parsed = json.loads(raw)
            return not isinstance(parsed, dict)
    except Exception:
        return True
    return False


def _recover_verified_initial_sl_from_mt5_history(mt5, pos, active_symbol, acc_login, acc_server):
    """Section III (Task 1): Recover initialSl and initialR ONLY from a verified position-opening record in MT5 history.
    - Verifies accountLogin, server, symbol, position_id/ticket, and opening timestamp (pos.time).
    - Distinguishes the initial opening order/deal (DEAL_ENTRY_IN / TRADE_ACTION_DEAL at open time) from later SL modifications.
    - Never picks an arbitrary SL on the risk side if it comes from a later modification or unverified record.
    - Never uses 6.8 fallback or current trailed SL.
    """
    pos_ticket = int(getattr(pos, "ticket", 0) or 0)
    pos_time = int(getattr(pos, "time", 0) or 0)
    entry = float(getattr(pos, "price_open", 0.0) or 0.0)
    buy = int(getattr(pos, "type", 0)) == 0
    if pos_ticket <= 0 or entry <= 0:
        return {"ok": False, "hadHistoryRecords": False, "reason": "INVALID_POSITION_FIELDS"}

    raw_deals = []
    raw_orders = []
    deals_fn = getattr(mt5, "history_deals_get", None)
    orders_fn = getattr(mt5, "history_orders_get", None)
    if callable(deals_fn):
        try:
            raw_deals = list(deals_fn(position=pos_ticket) or [])
        except Exception:
            raw_deals = []
    if callable(orders_fn):
        try:
            raw_orders = list(orders_fn(position=pos_ticket) or [])
        except Exception:
            raw_orders = []

    had_history = len(raw_deals) > 0 or len(raw_orders) > 0
    if not had_history:
        return {"ok": False, "hadHistoryRecords": False, "reason": "NO_MT5_HISTORY_RECORDS"}

    def _rec_matches_identity(rec):
        rec_login = getattr(rec, "account", None) or getattr(rec, "account_login", None) or getattr(rec, "login", None)
        if rec_login is not None and int(rec_login or 0) != 0 and int(acc_login or 0) != 0:
            if int(rec_login) != int(acc_login):
                return False, "ACCOUNT_MISMATCH"
        rec_srv = getattr(rec, "server", None)
        if rec_srv is not None and str(rec_srv).strip() and str(acc_server).strip():
            if not servers_match(str(rec_srv), str(acc_server)):
                return False, "SERVER_MISMATCH"
        rec_sym = getattr(rec, "symbol", None)
        if rec_sym is not None and str(rec_sym).strip():
            if str(rec_sym).strip() != str(active_symbol).strip():
                return False, "SYMBOL_MISMATCH"
        rec_pos_id = int(getattr(rec, "position_id", 0) or getattr(rec, "position", 0) or 0)
        rec_tk = int(getattr(rec, "ticket", 0) or getattr(rec, "order", 0) or 0)
        if rec_pos_id > 0:
            if rec_pos_id != pos_ticket:
                return False, "POSITION_ID_MISMATCH"
        elif rec_tk != pos_ticket:
            return False, "TICKET_MISMATCH"
        return True, "OK"

    valid_deals = []
    rejected_reasons = []
    for d in raw_deals:
        ok_id, r_id = _rec_matches_identity(d)
        if not ok_id:
            rejected_reasons.append(r_id)
            continue
        d_entry = int(getattr(d, "entry", 0) or 0)
        if d_entry != 0:  # 0 == DEAL_ENTRY_IN
            continue
        d_time = int(getattr(d, "time", 0) or 0)
        if pos_time > 0 and d_time > 0 and abs(d_time - pos_time) > 5:
            rejected_reasons.append("DEAL_OPEN_TIME_MISMATCH")
            continue
        valid_deals.append(d)

    opening_order_ticket_from_deal = 0
    opening_deal_ticket = 0
    if valid_deals:
        valid_deals.sort(key=lambda x: (int(getattr(x, "time", 0) or 0), int(getattr(x, "ticket", 0) or 0)))
        d0 = valid_deals[0]
        opening_deal_ticket = int(getattr(d0, "ticket", 0) or 0)
        opening_order_ticket_from_deal = int(getattr(d0, "order", 0) or 0)

    valid_orders = []
    for o in raw_orders:
        ok_id, r_id = _rec_matches_identity(o)
        if not ok_id:
            rejected_reasons.append(r_id)
            continue
        o_action = int(getattr(o, "action", 1) or 1)
        o_comment = str(getattr(o, "comment", "") or "").upper()
        # Action 6 is TRADE_ACTION_SLTP (SL/TP modification, not opening order)
        if o_action == 6 or any(tag in o_comment for tag in ("SLTP", "MODIFY", "TRAIL", "OPERATOR BE")):
            rejected_reasons.append("SL_MODIFICATION_RECORD_IGNORED")
            continue
        valid_orders.append(o)

    def _order_time(o_rec):
        return int(getattr(o_rec, "time_done", 0) or getattr(o_rec, "time_setup", 0) or getattr(o_rec, "time", 0) or 0)

    valid_orders.sort(key=lambda x: (_order_time(x), int(getattr(x, "ticket", 0) or 0)))

    chosen_rec = None
    chosen_source = None
    if opening_order_ticket_from_deal > 0 and valid_orders:
        for o in valid_orders:
            o_tk = int(getattr(o, "ticket", 0) or getattr(o, "order", 0) or 0)
            if o_tk == opening_order_ticket_from_deal:
                chosen_rec = o
                chosen_source = "MT5_HISTORY_OPENING_ORDER_LINKED_TO_DEAL"
                break

    if chosen_rec is None and valid_orders:
        if pos_time > 0:
            at_open = [o for o in valid_orders if _order_time(o) == 0 or abs(_order_time(o) - pos_time) <= 5]
            later_only = [o for o in valid_orders if _order_time(o) > 0 and abs(_order_time(o) - pos_time) > 5]
            if not at_open and later_only:
                return {
                    "ok": False,
                    "hadHistoryRecords": True,
                    "reason": "ONLY_MODIFIED_SL_AFTER_OPEN_TIME",
                }
            if at_open:
                distinct_sls = {round(float(getattr(o, "sl", 0.0) or 0.0), 2) for o in at_open if float(getattr(o, "sl", 0.0) or 0.0) > 0}
                if len(at_open) > 1 and len(distinct_sls) > 1 and all(_order_time(o) == 0 for o in at_open):
                    return {
                        "ok": False,
                        "hadHistoryRecords": True,
                        "reason": "AMBIGUOUS_UNTIMESTAMPED_SL_HISTORY",
                    }
                chosen_rec = at_open[0]
                chosen_source = "MT5_HISTORY_OPENING_ORDER"
        else:
            distinct_sls = {round(float(getattr(o, "sl", 0.0) or 0.0), 2) for o in valid_orders if float(getattr(o, "sl", 0.0) or 0.0) > 0}
            if len(valid_orders) > 1 and len(distinct_sls) > 1 and all(_order_time(o) == 0 for o in valid_orders):
                return {
                    "ok": False,
                    "hadHistoryRecords": True,
                    "reason": "AMBIGUOUS_UNTIMESTAMPED_SL_HISTORY",
                }
            chosen_rec = valid_orders[0]
            chosen_source = "MT5_HISTORY_OPENING_ORDER"

    if chosen_rec is None and valid_deals:
        chosen_rec = valid_deals[0]
        chosen_source = "MT5_HISTORY_OPENING_DEAL"

    if chosen_rec is None:
        return {
            "ok": False,
            "hadHistoryRecords": True,
            "reason": rejected_reasons[0] if rejected_reasons else "NO_VALID_OPENING_RECORD",
        }

    cand_sl = float(getattr(chosen_rec, "sl", 0.0) or 0.0)
    if cand_sl <= 0:
        return {
            "ok": False,
            "hadHistoryRecords": True,
            "reason": "OPENING_RECORD_HAD_NO_INITIAL_SL",
        }
    on_risk_side = (buy and 0 < cand_sl < entry) or (not buy and cand_sl > entry)
    dist = abs(entry - cand_sl)
    if not on_risk_side or not (0.1 < dist <= 30.0):
        return {
            "ok": False,
            "hadHistoryRecords": True,
            "reason": "OPENING_RECORD_SL_NOT_ON_RISK_SIDE",
        }

    rec_time = _order_time(chosen_rec) if chosen_source != "MT5_HISTORY_OPENING_DEAL" else int(getattr(chosen_rec, "time", 0) or 0)
    return {
        "ok": True,
        "hadHistoryRecords": True,
        "initialSl": round(cand_sl, 2),
        "initialR": round(dist, 4),
        "recoverySource": chosen_source,
        "recoveredAtTs": int(time.time() * 1000),
        "recoveryEvidence": {
            "accountLogin": int(acc_login or 0),
            "server": str(acc_server or ""),
            "symbol": str(active_symbol or ""),
            "positionId": pos_ticket,
            "openingTicket": int(getattr(chosen_rec, "ticket", 0) or getattr(chosen_rec, "order", 0) or pos_ticket),
            "openingDealTicket": opening_deal_ticket,
            "positionOpenTime": pos_time,
            "recordTime": rec_time,
            "verifiedInitialSl": round(cand_sl, 2),
        },
    }


def manage_trend_and_manual_positions(mt5, active_symbol, pos_list, candles_m5, candles_m15, candles_h1, candles_h4, mtf_analysis, mgmt_cfg):
    """Unified Position Manager (Section 2):
    - Uses evaluate_position_management_step() shared 100% with Backtest.
    - Persists state by accountLogin|server|ticket (and ticket key): actualEntry, initialSl, initialR, peak (favorableExtreme).
    - NEVER recalculates initialR from a moved SL.
    - BE triggers strictly at 1R (initialR), NEVER from DCA stepDistance (4.5).
    - Evaluates confirmed M5 structural trailing (pre-BE and post-BE) and M15 10 USD/oz extreme lock.
    - If SL modification is rejected by broker, retains old SL, records reason, and retries next cycle without closing position.
    - Keeps valid TP unchanged.
    """
    cfg_m = dict(mgmt_cfg or {})
    existing = [p for p in pos_list if str(getattr(p, "symbol", "")) == active_symbol]
    state = _load_manager_state()
    actions = []
    managed = 0

    account = mt5.account_info() if callable(getattr(mt5, "account_info", None)) else None
    acc_login = int(getattr(account, "login", 0) or cfg_m.get("accountLogin") or 0)
    acc_server = str(getattr(account, "server", "") or cfg_m.get("server") or "DEFAULT").strip()

    recent_m5 = closed(candles_m5)
    recent_m15 = closed(candles_m15)
    recent_h4 = closed(candles_h4)
    h4_high = max((b[1] for b in recent_h4[-16:]), default=0.0)
    h4_low = min((b[2] for b in recent_h4[-16:]), default=0.0)
    spike_dist = max(5.0, float(cfg_m.get("m15SpikeTrailDist") or 10.0))
    enable_trail = bool(cfg_m.get("enableM5StructuralTrail", True))
    adopt_manual = bool(cfg_m.get("semiAutoAdoptManual", False))

    sym_info = mt5.symbol_info(active_symbol) if callable(getattr(mt5, "symbol_info", None)) else None
    point = float(getattr(sym_info, "point", 0.01) or 0.01) if sym_info else 0.01
    freeze = float(getattr(sym_info, "trade_freeze_level", 0) or 0) * point if sym_info else 0.0
    stops = float(getattr(sym_info, "trade_stops_level", 0) or 0) * point if sym_info else 0.0
    min_broker_gap = max(0.80, point, freeze, stops)

    positions_read_ok = bool(cfg_m.get("positionsReadOk", True))
    scope_prefix_4 = f"{acc_login}|{acc_server}|{active_symbol}|"
    scope_prefix_3 = f"{acc_login}|{acc_server}|"
    active_ticket_ids = {str(int(getattr(p, "ticket", 0))) for p in existing}
    now_ms = int(time.time() * 1000)

    for p in existing:
        magic = int(getattr(p, "magic", 0) or 0)
        comment = str(getattr(p, "comment", "") or "").upper()
        is_v6_owned = magic == 270715 and (
            comment.startswith("V6_") or "XAUUSD_AI_MASTER_V6" in comment or comment.startswith("DCA_PLUS")
        )
        if not is_v6_owned and not (magic == 0 and adopt_manual):
            continue
        is_sideway = "BOT_2_SIDEWAY" in comment
        strategy_mode = "BOT_2_SIDEWAY" if is_sideway else "BOT_1_TREND"
        managed += 1

        comp_key, legacy_3_key = _position_state_keys(acc_login, acc_server, p.ticket, active_symbol)
        # Controlled migration (Task 2): only migrate legacy_3_key if accountLogin, server, and symbol match!
        raw_existing_item = state.get(comp_key)
        if raw_existing_item is None and legacy_3_key in state:
            cand_leg = state[legacy_3_key]
            if (
                isinstance(cand_leg, dict)
                and int(cand_leg.get("accountLogin") or 0) == int(acc_login)
                and servers_match(str(cand_leg.get("server") or ""), str(acc_server))
                and str(cand_leg.get("symbol") or active_symbol) == str(active_symbol)
            ):
                raw_existing_item = cand_leg
        item = dict(raw_existing_item or {})
        item["status"] = "OPEN"
        item["symbol"] = active_symbol
        side = "BUY" if int(p.type) == 0 else "SELL"
        buy = side == "BUY"
        entry = float(p.price_open)
        current = float(p.price_current)
        sl = float(getattr(p, "sl", 0.0) or 0.0)
        tp = float(getattr(p, "tp", 0.0) or 0.0)
        entry_time_ms = int(getattr(p, "time", 0) or 0) * 1000

        item["accountLogin"] = acc_login
        item["server"] = acc_server
        item["ticket"] = int(p.ticket)
        item["side"] = side
        item["actualEntry"] = entry

        # Section III (Task 1): Always attempt verified MT5 history recovery first when initialR is missing or stateUnverified
        if "initialR" not in item or float(item.get("initialR") or 0.0) <= 0 or item.get("stateUnverified"):
            sl_is_protective_past_entry = sl > 0 and ((buy and sl >= entry) or (not buy and sl <= entry))
            hist_rec = _recover_verified_initial_sl_from_mt5_history(mt5, p, active_symbol, acc_login, acc_server)
            if hist_rec.get("ok"):
                item["initialSl"] = hist_rec["initialSl"]
                item["initialR"] = hist_rec["initialR"]
                item["recoveredFromMt5History"] = True
                item["recoverySource"] = hist_rec["recoverySource"]
                item["recoveredAtTs"] = hist_rec["recoveredAtTs"]
                item["recoveryEvidence"] = hist_rec["recoveryEvidence"]
                item["stateUnverified"] = False
                item["reconcileFreezeDca"] = False
                item.pop("recoveryFailureReason", None)
            elif (
                not hist_rec.get("hadHistoryRecords")
                and not item.get("stateUnverified")
                and not bool(cfg_m.get("strictHistoryRecovery", False))
                and sl > 0
                and not sl_is_protective_past_entry
                and (MIN_STRUCTURAL_SL_DIST - 1e-6 <= abs(entry - sl) <= MAX_STRUCTURAL_SL_DIST + 1e-6)
            ):
                raw = abs(entry - sl)
                item["initialSl"] = round(sl, 2)
                item["initialR"] = round(raw, 4)
                item["recoverySource"] = "INITIAL_OPEN_STRUCTURAL_SL_OBSERVED"
                item["recoveredAtTs"] = now_ms
                item["recoveryEvidence"] = {
                    "accountLogin": acc_login,
                    "server": acc_server,
                    "symbol": active_symbol,
                    "positionId": int(p.ticket),
                    "positionOpenTime": int(getattr(p, "time", 0) or 0),
                    "verifiedInitialSl": round(sl, 2),
                }
                item["stateUnverified"] = False
            else:
                item.pop("initialR", None)
                item["stateUnverified"] = True
                item["reconcileFreezeDca"] = True
                item["recoveryFailureReason"] = hist_rec.get("reason", "UNVERIFIED_INITIAL_SL")
                item["lastRejectionReason"] = (
                    f"Mất bản ghi initialR gốc ({item['recoveryFailureReason']}) — khóa DCA, không thực hiện BE dựa trên R chưa xác minh, giữ nguyên SL bảo vệ hiện tại"
                )
        if "stateUnverified" in item and item.get("stateUnverified"):
            actions.append(f"ALERT Ticket #{p.ticket}: stateUnverified (khóa DCA, không tự gán initialR mới)")

        seen_prices = [current]
        if entry_time_ms:
            for candle in recent_m15:
                if int(candle[4]) >= entry_time_ms:
                    seen_prices.append(float(candle[1] if buy else candle[2]))
            for candle in recent_m5:
                if int(candle[4]) >= entry_time_ms:
                    seen_prices.append(float(candle[1] if buy else candle[2]))
        old_peak = float(item.get("peak", entry))
        item["peak"] = max([entry, old_peak] + seen_prices) if buy else min([entry, old_peak] + seen_prices)

        # Attach initial structural SL ONLY if the position currently has no SL (sl <= 0)
        if sl <= 0:
            if magic == 0 and not adopt_manual:
                continue
            stop = structural_stop(side, entry, candles_m5, candles_m15, max_distance=MAX_STRUCTURAL_SL_DIST)
            used_fallback_sl = False
            if stop is None:
                stop = round(entry - 6.8 if buy else entry + 6.8, 2)
                used_fallback_sl = True
            attached_tp = tp
            if attached_tp <= 0 and h4_high and h4_low:
                attached_tp = round(max(entry + abs(entry - stop) * 2.2, h4_high) if buy else min(entry - abs(entry - stop) * 2.2, h4_low), 2)
            sl_attach_label = "Attach fallback protective SL (6.8 USD/oz — no structure found)" if used_fallback_sl else "Attach valid structural SL"
            mod = modify_position_sl_tp(mt5, p, stop, attached_tp if tp <= 0 else None, sl_attach_label)
            if not mod.get("changed"):
                item["lastRejectionReason"] = mod.get("message")
                item["slSource"] = "MISSING_SL_FAILED_ATTACH"
                state[comp_key] = item
                actions.append(f"ALERT Ticket #{p.ticket}: could not attach protective SL ({mod.get('message')})")
                continue
            actions.append(mod["message"])
            sl = stop
            if tp <= 0:
                tp = attached_tp
            if used_fallback_sl:
                item["slSource"] = "FALLBACK_PROTECTIVE_6_8"
                item["stateUnverified"] = True
                item["reconcileFreezeDca"] = True
                actions.append(f"ALERT Ticket #{p.ticket}: thiếu SL và không xác định được cấu trúc — gắn bảo vệ dự phòng 6.8 giá và khóa DCA")
            else:
                item["slSource"] = "STRUCTURAL_ATTACHED"
            item["initialSl"] = round(sl, 2)
            item["initialR"] = round(abs(entry - sl), 4)

        raw_item_r = item.get("initialR")
        if raw_item_r is None or float(raw_item_r or 0.0) <= 0:
            item["stateUnverified"] = True
            item["reconcileFreezeDca"] = True
            item["lastRejectionReason"] = "STATE_UNVERIFIED: Thiếu initialR gốc — giữ nguyên SL bảo vệ hiện tại, không suy đoán 6.8"
            item["updatedAtMs"] = now_ms
            state[comp_key] = item
            actions.append(f"ALERT Ticket #{p.ticket}: STATE_UNVERIFIED (thiếu initialR gốc, giữ nguyên SL {sl:.2f}, khóa BE/DCA)")
            continue
        initial_r = float(raw_item_r)
        step_res = evaluate_position_management_step(
            side=side,
            entry=entry,
            current_price=current,
            current_sl=sl,
            current_tp=tp,
            initial_r=initial_r,
            favorable_extreme=item["peak"],
            confirmed_m5=recent_m5,
            confirmed_m15=recent_m15,
            strategy_mode=strategy_mode,
            config={
                "beAtOneR": bool(cfg_m.get("beAtOneR", True)),
                "beTriggerRMultiple": float(cfg_m.get("beTriggerRMultiple") or 1.0),
                "beBufferPts": float(cfg_m.get("beBufferPts") if cfg_m.get("beBufferPts") is not None else 0.25),
                "roundTripCostPts": float(cfg_m.get("roundTripCostPts") if cfg_m.get("roundTripCostPts") is not None else DEFAULT_ROUND_TRIP_COST_PTS),
                "beCompensateCost": bool(cfg_m.get("beCompensateCost", True)),
                "enableM5StructuralTrail": enable_trail,
                "m15SpikeTrailDist": spike_dist,
                "minBrokerStopGap": min_broker_gap,
                "sidewayEnableM5Trail": bool(cfg_m.get("sidewayEnableM5Trail", True)),
                "sidewayEnablePeakLock": bool(cfg_m.get("sidewayEnablePeakLock", False)),
            },
        )
        item["peak"] = step_res["favorableExtreme"]

        if step_res["shouldModifySl"]:
            best_sl = step_res["newSl"]
            reason = step_res["reason"]
            mod = modify_position_sl_tp(mt5, p, best_sl, None, reason)
            if mod.get("changed"):
                actions.append(mod["message"])
                sl = best_sl
                item["currentSl"] = best_sl
                item["atBe"] = step_res["atBeAfter"]
                item["preBeTrailed"] = step_res["preBeTrailed"]
                item["lastSlUpdateTs"] = int(time.time() * 1000)
                item["lastRejectionReason"] = None
            elif not mod.get("ok"):
                item["lastRejectionReason"] = mod.get("message")
                actions.append(
                    f"ALERT Ticket #{p.ticket}: SL update rejected ({mod.get('message')}) — keeping prior SL {sl:.2f} and keeping position open"
                )

        item["updatedAtMs"] = now_ms
        state[comp_key] = item

    updated_items = {k: v for k, v in state.items() if k.startswith(scope_prefix_4)}
    def _merge_and_preserve(disk_state):
        for k, v in updated_items.items():
            disk_state[k] = v
            t_part = k.split("|")[-1]
            old_3 = f"{scope_prefix_3}{t_part}"
            if old_3 in disk_state:
                disk_state.pop(old_3, None)
        if positions_read_ok:
            for dk in list(disk_state.keys()):
                is_in_scope = dk.startswith(scope_prefix_4) or (
                    dk.startswith(scope_prefix_3) and dk.count("|") == 2 and str(disk_state[dk].get("symbol") or active_symbol) == active_symbol
                )
                if not is_in_scope:
                    continue
                t_part = dk.split("|")[-1]
                if t_part not in active_ticket_ids:
                    rec = dict(disk_state[dk])
                    if rec.get("status") != "CLOSED":
                        rec["status"] = "CLOSED"
                        rec["closedAtMs"] = now_ms
                        disk_state[dk] = rec
        cutoff_ms = now_ms - (7 * 86400 * 1000)
        for dk in list(disk_state.keys()):
            rec = disk_state.get(dk)
            if isinstance(rec, dict) and rec.get("status") == "CLOSED" and int(rec.get("closedAtMs") or 0) < cutoff_ms:
                del disk_state[dk]
        return disk_state

    _update_json_state(MANAGER_STATE_FILE, _merge_and_preserve)
    return {
        "managedCount": managed,
        "actions": actions,
        "pollingCycleNote": "Position manager evaluates closed M5/M15 candles and live quotes every polling cycle; 10 USD/oz extreme lock is best-effort subject to tick/broker latency.",
        "summary": " | ".join(actions) if actions else f"Managing {managed} owned positions; no broker modification needed"
    }


def _reconcile_filled_order(mt5, active_symbol, req_side, req_vol, req_price, req_sl, req_tp, res, account, max_retries=3, retry_delay_sec=0.12):
    """Section 2 (P0): Verify actual broker position after DONE.
    - Never uses requested price/vol/sl/tp as proof of fill.
    - Distinguishes order ticket, deal ticket, and position ticket.
    - Retries readback up to max_retries before returning RECONCILIATION_PENDING.
    """
    order_ticket = int(getattr(res, "order", 0) or 0)
    deal_ticket = int(getattr(res, "deal", 0) or 0)
    position_id = int(getattr(res, "position", 0) or 0)
    req_type = 0 if str(req_side).upper() == "BUY" else 1

    readback_pos = None
    for attempt in range(max(1, int(max_retries))):
        if position_id > 0:
            readback_pos = _read_position_by_ticket(mt5, position_id)
        if readback_pos is None and order_ticket > 0 and callable(getattr(mt5, "history_deals_get", None)):
            try:
                deals = mt5.history_deals_get(ticket=order_ticket) or []
                for d in deals:
                    if getattr(d, "order", None) != order_ticket:
                        continue
                    if deal_ticket and getattr(d, "ticket", None) != deal_ticket:
                        continue
                    d_pos = int(getattr(d, "position_id", 0) or getattr(d, "position", 0) or 0)
                    if d_pos > 0:
                        readback_pos = _read_position_by_ticket(mt5, d_pos)
                        if readback_pos is not None:
                            break
            except Exception:
                pass
        if readback_pos is None and order_ticket > 0:
            readback_pos = _read_position_by_ticket(mt5, order_ticket)
        if readback_pos is None and callable(getattr(mt5, "positions_get", None)):
            try:
                sym_positions = mt5.positions_get(symbol=active_symbol) or []
                for p in sym_positions:
                    p_ident = int(getattr(p, "identifier", 0) or 0)
                    p_type = int(getattr(p, "type", -1))
                    if order_ticket > 0 and p_ident == order_ticket and p_type == req_type:
                        readback_pos = p
                        break
            except Exception:
                pass
        if readback_pos is not None:
            break
        if attempt + 1 < max(1, int(max_retries)) and retry_delay_sec > 0:
            time.sleep(retry_delay_sec)

    return readback_pos, order_ticket, deal_ticket


def _read_uncertain_entry_state():
    """Reject corrupt/unreadable state instead of silently treating it as empty."""
    file_path = RUNTIME_DIR / "v6-uncertain-entry-state.json"
    with _cross_process_file_lock(file_path):
        if not file_path.exists():
            return {}
        state = json.loads(file_path.read_text(encoding="utf-8"))
        if not isinstance(state, dict):
            raise ValueError("Uncertain entry state is not an object")
        return state


def _write_uncertain_entry_state(state):
    file_path = RUNTIME_DIR / "v6-uncertain-entry-state.json"
    with _cross_process_file_lock(file_path):
        _save_json_state_unlocked(file_path, state)


def _entry_fill_evidence(mt5, intent):
    """Report broker deal tickets without clearing the persistent entry freeze."""
    unknown = {"status": "UNVERIFIED"}
    if not isinstance(intent, dict) or not intent.get("brokerComment"):
        return unknown
    try:
        start = datetime.datetime.fromtimestamp(intent["createdAtUtc"], datetime.timezone.utc)
        end = datetime.datetime.now(datetime.timezone.utc)
        deals = mt5.history_deals_get(start, end)
        if not isinstance(deals, (list, tuple)):
            return unknown
        fills = {}
        for deal in deals:
            if (deal.comment == intent["brokerComment"] and deal.symbol == intent["symbol"]
                    and deal.magic == 270715 and deal.type == {"BUY": 0, "SELL": 1}[intent["side"]]
                    and deal.ticket > 0 and deal.volume > 0 and isfinite(deal.volume)):
                ticket = int(deal.ticket)
                fill = (float(deal.volume), getattr(deal, "position_id", None))
                if ticket in fills and fills[ticket] != fill:
                    return unknown
                fills[ticket] = fill
        if not fills:
            return unknown
        observed = round(sum(volume for volume, _ in fills.values()), 8)
        result = {"status": "EXECUTION_OBSERVED", "dealTickets": sorted(fills),
                  "observedDealVolume": observed, "positionReadbackAvailable": False}
        position_ids = {position for _, position in fills.values()}
        if len(position_ids) == 1 and None not in position_ids:
            positions, available, _ = _safe_read_positions(mt5, intent["symbol"])
            linked = [p for p in positions if getattr(p, "identifier", None) in position_ids
                      and p.symbol == intent["symbol"] and p.magic == 270715
                      and p.type == {"BUY": 0, "SELL": 1}[intent["side"]]]
            if available and len(linked) == 1 and next(iter(position_ids)) > 0:
                pos = linked[0]
                if pos.ticket > 0 and all(isfinite(v) and v > 0 for v in (pos.volume, pos.sl, pos.tp)):
                    result.update(positionReadbackAvailable=True, positionTicket=int(pos.ticket),
                                  positionVolume=pos.volume, brokerSl=pos.sl, brokerTp=pos.tp)
        requested = intent.get("requestedVolume")
        if isinstance(requested, (int, float)) and isfinite(requested) and requested > 0:
            result["requestedVolume"] = requested
            result["observedVolumeMatchesRequest"] = abs(requested - observed) < 1e-8
        account = mt5.account_info()
        if account.login != intent["accountLogin"] or account.server != intent["server"]:
            return unknown
        return result
    except Exception:
        return unknown
    return unknown


def execute_order(mt5, active_symbol, order_cfg, comment_tag="XAUUSD_AI_MASTER_V6"):
    """Serialize entry, persist pre-submission intent, and freeze uncertain exposure.

    A pending marker is written BEFORE entering the broker execution gateway.
    Crash/timeout/ambiguous fill keeps it latched across restarts until verified
    human/broker reconciliation. Existing SL/TP management is unaffected.
    """
    try:
        with _strict_new_order_lock():
            try:
                account = mt5.account_info()
                if account is None:
                    return {"ok": False, "submitted": False, "status": "BLOCKED_ACCOUNT_UNVERIFIED"}
                login = int(getattr(account, "login", 0) or 0)
                server = str(getattr(account, "server", "") or "").strip()
                if login <= 0 or not server:
                    return {"ok": False, "submitted": False, "status": "BLOCKED_ACCOUNT_UNVERIFIED"}
                key = f"{login}|{server}"
                state = _read_uncertain_entry_state()
                if key in state:
                    return {
                        "ok": False, "submitted": False,
                        "status": "BLOCKED_UNCERTAIN_PREVIOUS_ENTRY",
                        "fillEvidence": _entry_fill_evidence(mt5, state[key]),
                        "message": "A prior entry attempt may have reached broker; verify positions/orders before clearing the persistent freeze",
                    }
                broker_comment = f"{comment_tag[:19]}:{uuid.uuid4().hex[:11]}"
                state[key] = {
                    "symbol": active_symbol,
                    "side": str((order_cfg or {}).get("side", "")).strip().upper(),
                    "brokerComment": broker_comment,
                    "requestedVolume": (order_cfg or {}).get("volume"),
                    "status": "ENTRY_IN_FLIGHT",
                    "accountLogin": login,
                    "server": server,
                    "createdAtUtc": int(time.time()),
                }
                _write_uncertain_entry_state(state)
            except (OSError, ValueError, TypeError) as exc:
                return {
                    "ok": False, "submitted": False,
                    "status": "BLOCKED_ENTRY_STATE_UNAVAILABLE",
                    "message": f"Cannot verify/persist broker entry intent (fail-closed): {exc}",
                }

            # An exception or process crash intentionally leaves the durable
            # in-flight marker in place; never auto-retry a possibly sent order.
            result = _execute_order_serialized(mt5, active_symbol, order_cfg, broker_comment)
            if result.get("uncertain"):
                result["fillEvidence"] = _entry_fill_evidence(mt5, state[key])
                return result
            try:
                state = _read_uncertain_entry_state()
                state.pop(key, None)
                _write_uncertain_entry_state(state)
            except (OSError, ValueError, TypeError):
                # No further new orders may proceed without verified reconciliation.
                result = dict(result)
                result["entryStateFreezeUnverified"] = True
            return result
    except _EntryExecutionLockUnavailable as exc:
        return {
            "ok": False, "submitted": False,
            "status": "BLOCKED_ENTRY_LOCK_UNAVAILABLE",
            "message": f"Cannot acquire new-order execution lock (fail-closed): {exc}",
        }


def _execute_order_serialized(mt5, active_symbol, order_cfg, comment_tag="XAUUSD_AI_MASTER_V6"):
    """Unified Fail-Closed Execution Gateway & Final Pre-Send SL Gate (Section 1.2, 1.3, 1.4).
    Unit convention: 1 price unit ("1 giá") = 1.00 USD/oz (distinct from broker `point`).
    """
    cfg_o = order_cfg or {}
    side = str(cfg_o.get("side") or "").strip().upper()
    if side not in ("BUY", "SELL"):
        return {"ok": False, "message": "Explicit BUY or SELL direction required"}
    if "volume" not in cfg_o or cfg_o.get("volume") is None or str(cfg_o.get("volume")).strip() == "":
        return {"ok": False, "message": "Missing explicit Fixed Lot volume (never auto-defaulting)"}
    try:
        volume = float(cfg_o.get("volume"))
    except (TypeError, ValueError):
        return {"ok": False, "message": "Invalid requested volume"}
    if not isfinite(volume) or volume <= 0:
        return {"ok": False, "message": "Nonpositive or non-finite requested volume (volume=0 rejected)"}
    sl_points_price = float(cfg_o.get("slDistance") or 6.8)
    tp_points_price = float(cfg_o.get("tpDistance") or 16.0)

    # Gate 1: Terminal connection & Account binding / LIVE authorization check
    term_info = None
    if callable(getattr(mt5, "terminal_info", None)):
        try:
            term_info = mt5.terminal_info()
        except Exception:
            term_info = None
        if term_info is not None and getattr(term_info, "connected", True) is False:
            return {"ok": False, "message": "MT5 terminal disconnected; order blocked (fail-closed)"}

    account = mt5.account_info()
    if account is None or float(getattr(account, "equity", 0) or 0) <= 0:
        return {"ok": False, "message": "Cannot verify positive account equity"}
    margin_mode = getattr(account, "margin_mode", 2)
    netting_const = int(getattr(mt5, "ACCOUNT_MARGIN_MODE_RETAIL_NETTING", 0))
    if margin_mode is not None and int(margin_mode) == netting_const and cfg_o.get("allowNetting") is not True:
        return {
            "ok": False,
            "status": "NETTING_MODE_UNSUPPORTED",
            "message": "Tài khoản đang ở chế độ Netting (chưa hỗ trợ đầy đủ đối soát nhiều vị thế tách biệt). Vui lòng dùng tài khoản Hedging.",
        }

    if any(k in cfg_o for k in ("login", "expectedLogin", "server", "expectedServer", "accountMode", "expectedAccountMode")):
        ok_bind, bind_err = verify_mt5_account_binding(mt5, cfg_o, account=account)
        if not ok_bind:
            return {"ok": False, "message": f"Account verification failed: {bind_err}"}

    trade_mode = int(getattr(account, "trade_mode", 0) or 0)
    real_mode_const = int(getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2))
    if trade_mode == real_mode_const:
        # Do not treat three client flags alone as authorization for REAL orders.
        # Verify terminal connectivity/permissions and explicit account binding.
        if not all(str(cfg_o.get(k) or "").strip() for k in ("login", "server", "accountMode")):
            return {
                "ok": False, "submitted": False,
                "status": "BLOCKED_LIVE_ACCOUNT_BINDING",
                "message": "LIVE order blocked: explicit login, server, accountMode binding required",
            }
        if str(cfg_o["accountMode"]).strip().upper() not in ("LIVE", "REAL"):
            return {
                "ok": False, "submitted": False,
                "status": "BLOCKED_LIVE_ACCOUNT_BINDING",
                "message": "LIVE order blocked: configured account mode is not LIVE/REAL",
            }
        live_ok, live_reason = verify_live_execution_gate(mt5, account, term_info, cfg_o)
        if not live_ok:
            return {
                "ok": False, "submitted": False,
                "status": "BLOCKED_LIVE_EXECUTION_GATE",
                "message": f"LIVE order blocked: {live_reason}",
            }

    # Gate 2: Symbol & Fresh Pre-Send Quote Verification
    sym_info = mt5.symbol_info(active_symbol)
    if sym_info is None:
        return {"ok": False, "message": f"Không tìm thấy mã {active_symbol} trên MT5."}
    if not getattr(sym_info, "visible", False):
        mt5.symbol_select(active_symbol, True)

    tick = mt5.symbol_info_tick(active_symbol)
    if tick is None:
        return {"ok": False, "message": f"Không đọc được giá Bid/Ask cho {active_symbol}."}

    # Do not silently substitute guessed symbol precision or stop levels
    # for absent broker metadata: the final SL/TP distance gate depends on it.
    try:
        raw_digits = getattr(sym_info, "digits", None)
        raw_point = getattr(sym_info, "point", None)
        raw_stops_level = getattr(sym_info, "trade_stops_level", None)
        if any(v is None or isinstance(v, bool)
               for v in (raw_digits, raw_point, raw_stops_level)):
            raise ValueError("missing or boolean symbol specification")
        digits = int(raw_digits)
        point = float(raw_point)
        stops_level = float(raw_stops_level)
        if not (float(raw_digits) == digits and 0 <= digits <= 16
                and isfinite(point) and point > 0
                and isfinite(stops_level) and stops_level >= 0
                and stops_level.is_integer()):
            raise ValueError("invalid symbol specification")
    except (ValueError, TypeError, OverflowError):
        return {"ok": False, "submitted": False, "status": "BLOCKED_BROKER_SYMBOL_SPEC_UNVERIFIED",
                "message": "Broker point/digits/stops-level specification missing or invalid"}
    raw_vmin = getattr(sym_info, "volume_min", None)
    raw_vstep = getattr(sym_info, "volume_step", None)
    raw_vmax = getattr(sym_info, "volume_max", None)
    if raw_vmin is None or raw_vstep is None or raw_vmax is None:
        return {"ok": False, "message": "Missing broker volume bounds (volume_min/volume_max/volume_step); order blocked"}
    vol_min = float(raw_vmin)
    volume_step = float(raw_vstep)
    volume_max = float(raw_vmax)
    if not (isfinite(vol_min) and isfinite(volume_step) and isfinite(volume_max)) or vol_min <= 0 or volume_step <= 0 or volume_max < vol_min:
        return {"ok": False, "message": "Invalid broker volume specification; order blocked"}
    if volume < vol_min - 1e-12 or volume > volume_max + 1e-12:
        return {"ok": False, "message": "Lot outside broker volume bounds; never increase requested risk"}
    if abs(round(volume / volume_step) * volume_step - volume) > 1e-6:
        return {"ok": False, "message": "Lot is not compatible with broker volume step"}

    is_buy = side == "BUY"
    price = float(tick.ask if is_buy else tick.bid)
    if not isfinite(price) or price <= 0:
        return {"ok": False, "message": "Invalid executable quote price"}

    # Gate 3: Pure UTC Tick Freshness & Spread Gate
    stops_gap = max(point, stops_level * point)
    spread_points = (float(tick.ask) - float(tick.bid)) / point
    max_quote_age = float(cfg_o.get("maxQuoteAgeSeconds") or DEFAULT_MAX_QUOTE_AGE_SEC)
    fresh_ok, quote_age, fresh_err = verify_tick_freshness_utc(tick, max_age_sec=max_quote_age)
    max_spread = float(cfg_o.get("maxSpreadPoints", 65))
    if not fresh_ok or not (0 <= spread_points <= max_spread):
        return {
            "ok": False,
            "message": fresh_err or f"Spread ({spread_points:.1f} pts) exceeds maximum ({max_spread} pts)"
        }

    # Gate 4: Final Pre-Send SL Distance (6.0–8.0 USD/oz) & Structural Invalidation Check (Section 1.4)
    explicit_sl = float(cfg_o.get("explicitSlPrice") or 0.0)
    explicit_tp = float(cfg_o.get("explicitTpPrice") or 0.0)
    if explicit_sl > 0:
        sl = round(explicit_sl, digits)
    else:
        sl = round(price - sl_points_price if is_buy else price + sl_points_price, digits) if sl_points_price > 0 else 0.0
    if explicit_tp > 0:
        tp = round(explicit_tp, digits)
    else:
        tp = round(price + tp_points_price if is_buy else price - tp_points_price, digits) if tp_points_price > 0 else 0.0

    if not (sl > 0 and tp > 0):
        return {"ok": False, "message": "Invalid order side / missing broker SL or TP"}

    struct_inv = cfg_o.get("structuralInvalidationPrice")
    if struct_inv is not None and isfinite(float(struct_inv)) and float(struct_inv) > 0:
        inv_p = float(struct_inv)
        if (is_buy and sl >= inv_p) or (not is_buy and sl <= inv_p):
            return {
                "ok": False,
                "message": f"Rejected: SL ({sl:.2f}) is not outside structural invalidation level ({inv_p:.2f})"
            }

    initial_r = round((price - sl) if is_buy else (sl - price), 4)
    if not isfinite(initial_r) or initial_r <= 0:
        return {"ok": False, "message": "SL violates market direction at current executable quote"}

    # Enforce strict 6.0–8.0 USD/oz (1 giá = 1 USD/oz) at final pre-send gate:
    # - If live quote moved such that initial_r > 8.0 USD/oz -> return WAIT_PULLBACK; NEVER pull SL inside structure!
    if initial_r > MAX_STRUCTURAL_SL_DIST + 1e-6:
        return {
            "ok": False,
            "status": "WAIT_PULLBACK",
            "slDistance": round(initial_r, 2),
            "message": (
                f"WAIT_PULLBACK: Pre-send quote at {price:.2f} makes SL distance {initial_r:.2f} USD/oz "
                f"(> {MAX_STRUCTURAL_SL_DIST:.1f} USD/oz cap); never force SL inside structure"
            ),
        }

    # - If initial_r < 6.0 USD/oz -> widen outward to 6.0 USD/oz ONLY if valid, and recompute risk & R:R!
    if initial_r < MIN_STRUCTURAL_SL_DIST - 1e-6:
        if cfg_o.get("allowWidenSlToMin6", True) is False:
            return {
                "ok": False,
                "slDistance": round(initial_r, 2),
                "message": f"Rejected: SL distance {initial_r:.2f} USD/oz is below {MIN_STRUCTURAL_SL_DIST:.1f} USD/oz minimum",
            }
        widened_sl = round(price - MIN_STRUCTURAL_SL_DIST if is_buy else price + MIN_STRUCTURAL_SL_DIST, digits)
        if struct_inv is not None and isfinite(float(struct_inv)) and float(struct_inv) > 0:
            inv_p = float(struct_inv)
            if (is_buy and widened_sl >= inv_p) or (not is_buy and widened_sl <= inv_p):
                return {"ok": False, "message": "Rejected: widened 6.0 USD/oz SL still inside structural invalidation"}
        sl = widened_sl
        initial_r = round((price - sl) if is_buy else (sl - price), 4)

    reward = (tp - price) if is_buy else (price - tp)
    round_trip_cost = max(0.0, float(cfg_o.get("roundTripCostPts") or 0.0))
    net_reward = reward - round_trip_cost
    min_rr = max(1.2, float(cfg_o.get("minRewardRisk") or 1.2))
    if not isfinite(reward) or net_reward / initial_r < min_rr - 1e-6:
        return {"ok": False, "message": f"Entry RR invalid after broker executable Bid/Ask ({net_reward / initial_r:.2f} < {min_rr:.2f})"}

    if (is_buy and not (sl < float(tick.bid) - stops_gap and tp > float(tick.ask) + stops_gap)) or (
        not is_buy and not (sl > float(tick.ask) + stops_gap and tp < float(tick.bid) - stops_gap)
    ):
        return {"ok": False, "message": "SL/TP violates market direction or broker stop distance"}

    # Gate 5: Unified Portfolio Risk Engine (<= 1.0% per trade, <= 1.5% total portfolio, daily loss from MT5 deals, drawdown, margin)
    calc = getattr(mt5, "order_calc_profit", None)
    if not callable(calc):
        return {"ok": False, "message": "Broker risk-calculation API unavailable"}
    order_type = int(getattr(mt5, "ORDER_TYPE_BUY", 0) if is_buy else getattr(mt5, "ORDER_TYPE_SELL", 1))
    try:
        expected_at_sl = float(calc(order_type, active_symbol, volume, price, sl))
    except Exception:
        return {"ok": False, "submitted": False, "status": "BLOCKED_SL_RISK_UNVERIFIED",
                "message": "Broker cannot calculate new-order SL risk"}
    if not isfinite(expected_at_sl):
        return {"ok": False, "submitted": False, "status": "BLOCKED_SL_RISK_UNVERIFIED",
                "message": "Broker returned invalid new-order SL risk"}
    # The final entry stop is strictly adverse to the executable entry price.
    # A zero/positive broker PnL at that stop contradicts the validated SL
    # direction and would otherwise understate risk as $0 with FIXED_LOT.
    if expected_at_sl >= 0:
        return {"ok": False, "submitted": False, "status": "BLOCKED_SL_RISK_UNVERIFIED",
                "message": "Broker returned non-loss PnL for an adverse new-order SL"}
    try:
        equity = float(getattr(account, "equity", None))
        balance = float(getattr(account, "balance", None))
    except (TypeError, ValueError, OverflowError):
        return {"ok": False, "submitted": False, "status": "BLOCKED_ACCOUNT_RISK_UNVERIFIED",
                "message": "Broker account balance/equity unavailable"}
    if not isfinite(equity) or equity <= 0 or not isfinite(balance) or balance <= 0:
        return {"ok": False, "submitted": False, "status": "BLOCKED_ACCOUNT_RISK_UNVERIFIED",
                "message": "Broker account balance/equity invalid"}
    new_risk = max(0.0, -expected_at_sl) * 1.05

    # Section VII: FIXED_LOT + Risk Monitoring as WARNINGS ONLY (never auto-block on 1%/1.5%/3%/6% equity thresholds)
    risk_warnings = []
    warn_per_trade_pct = float(cfg_o.get("maxRiskPercent", HARD_MAX_RISK_PER_TRADE_PCT))
    warn_total_pct = float(cfg_o.get("maxPortfolioRiskPercent", HARD_MAX_PORTFOLIO_RISK_PCT))
    new_risk_pct = round((new_risk / max(1.0, equity)) * 100.0, 2)
    if new_risk > equity * warn_per_trade_pct / 100.0:
        risk_warnings.append(
            f"WARNING_PER_TRADE_RISK: Rủi ro lệnh ${new_risk:.2f} ({new_risk_pct:.2f}% Equity) vượt ngưỡng cảnh báo {warn_per_trade_pct:.2f}% (Vẫn cho phép mở theo Fixed Lot)"
        )

    warn_dd_pct = float(cfg_o.get("maxDrawdownPercent") or DEFAULT_MAX_DRAWDOWN_PCT)
    cur_dd_pct = round(((balance - equity) / balance) * 100.0, 2) if balance > 0 else 0.0
    if cur_dd_pct > warn_dd_pct:
        risk_warnings.append(
            f"WARNING_DRAWDOWN: Drawdown hiện tại {cur_dd_pct:.2f}% vượt ngưỡng cảnh báo {warn_dd_pct:.2f}%"
        )

    # Mandatory broker safety gate: never assume free margin or order margin.
    # A missing, malformed or inaccessible broker API must fail closed.
    try:
        free_margin_val = float(getattr(account, "margin_free", None))
    except (TypeError, ValueError, OverflowError):
        return {"ok": False, "submitted": False, "status": "BLOCKED_MARGIN_UNVERIFIED",
                "message": "Cannot verify broker free margin for new entry"}
    if not isfinite(free_margin_val) or free_margin_val <= 0:
        return {"ok": False, "submitted": False, "status": "BLOCKED_MARGIN_UNVERIFIED",
                "message": "Broker free margin unavailable or insufficient"}
    calc_margin = getattr(mt5, "order_calc_margin", None)
    if not callable(calc_margin):
        return {"ok": False, "submitted": False, "status": "BLOCKED_MARGIN_UNVERIFIED",
                "message": "Broker order_calc_margin API unavailable"}
    try:
        margin_raw = calc_margin(order_type, active_symbol, volume, price)
        needed_margin = float(margin_raw)
    except Exception:
        return {"ok": False, "submitted": False, "status": "BLOCKED_MARGIN_UNVERIFIED",
                "message": "Broker order_calc_margin failed"}
    if not isfinite(needed_margin) or needed_margin <= 0:
        return {"ok": False, "submitted": False, "status": "BLOCKED_MARGIN_UNVERIFIED",
                "message": "Broker order margin is invalid"}
    if needed_margin > free_margin_val * 0.95:
        return {"ok": False, "submitted": False, "status": "BLOCKED_INSUFFICIENT_MARGIN",
                "message": "Rejected: requested order exceeds 95% of verified free margin"}

    existing_positions, positions_ok, _ = _safe_read_positions(mt5)
    if not positions_ok:
        return {"ok": False, "submitted": False, "status": "BLOCKED_PORTFOLIO_RISK_UNVERIFIED",
                "message": "Cannot verify broker portfolio positions; new order blocked"}
    open_risk = 0.0
    for existing in existing_positions:
        try:
            old_sl = float(getattr(existing, "sl", None))
            old_type = int(getattr(existing, "type", None))
            old_symbol = str(getattr(existing, "symbol", "") or "").strip()
            old_volume = float(getattr(existing, "volume", None))
            old_entry = float(getattr(existing, "price_open", None))
            if (old_type not in (0, 1) or not old_symbol or
                not all(isfinite(v) and v > 0 for v in (old_sl, old_volume, old_entry))):
                raise ValueError("Invalid open-position inventory")
            old_profit = float(calc(old_type, old_symbol, old_volume, old_entry, old_sl))
            if not isfinite(old_profit):
                raise ValueError("Invalid broker SL risk")
        except Exception:
            return {"ok": False, "submitted": False, "status": "BLOCKED_PORTFOLIO_RISK_UNVERIFIED",
                    "message": "Cannot verify open-position inventory or SL risk"}
        open_risk += max(0.0, -old_profit) * 1.05

    # Pending inventory is mandatory for every new entry, including offline mocks.
    # Never interpret an unavailable or malformed broker snapshot as no orders.
    pending_risk = 0.0
    orders_get_fn = getattr(mt5, "orders_get", None)
    if not callable(orders_get_fn):
        return {"ok": False, "submitted": False, "status": "BLOCKED_ORDERS_UNAVAILABLE",
                "message": "Cannot verify broker pending orders: API unavailable"}
    try:
        pending_orders = orders_get_fn()
    except Exception:
        pending_orders = None
    if not isinstance(pending_orders, (list, tuple)):
        return {"ok": False, "submitted": False, "status": "BLOCKED_ORDERS_UNAVAILABLE",
                "message": "Cannot verify broker pending orders: invalid inventory"}
    for pend in pending_orders:
        try:
            pend_type_raw = int(getattr(pend, "type", None))
            # Only pending MT5 types are valid: BUY/SELL LIMIT, STOP, STOP LIMIT.
            # Market BUY/SELL (0/1) and unknown types are not pending orders.
            if pend_type_raw not in (2, 3, 4, 5, 6, 7):
                raise ValueError("Unknown pending order type")
            pend_dir = 0 if pend_type_raw in (2, 4, 6) else 1
            pend_sl = float(getattr(pend, "sl", None))
            pend_vol_raw = getattr(pend, "volume_current", None)
            if pend_vol_raw is None:
                pend_vol_raw = getattr(pend, "volume_initial", None)
            pend_vol = float(pend_vol_raw)
            pend_price = float(getattr(pend, "price_open", None))
            pend_sym = str(getattr(pend, "symbol", "") or "").strip()
            if not (
                isfinite(pend_sl) and isfinite(pend_vol) and isfinite(pend_price)
                and pend_sl > 0 and pend_vol > 0 and pend_price > 0 and pend_sym
            ):
                raise ValueError("Incomplete pending order")
            if (pend_dir == 0 and pend_sl >= pend_price) or (pend_dir == 1 and pend_sl <= pend_price):
                raise ValueError("Pending SL is on wrong side")
            pend_loss = calc(pend_dir, pend_sym, pend_vol, pend_price, pend_sl)
            if pend_loss is None or not isfinite(float(pend_loss)):
                raise ValueError("Cannot price pending SL risk")
            pending_risk += max(0.0, -float(pend_loss)) * 1.05
        except Exception:
            return {"ok": False, "submitted": False, "status": "BLOCKED_INVALID_PENDING_ORDER",
                    "message": "Pending order inventory or risk is invalid; new order blocked"}

    total_portfolio_risk_usd = round(open_risk + pending_risk + new_risk, 2)
    total_portfolio_risk_pct = round((total_portfolio_risk_usd / max(1.0, equity)) * 100.0, 2)
    if total_portfolio_risk_usd > equity * warn_total_pct / 100.0:
        risk_warnings.append(
            f"WARNING_PORTFOLIO_RISK: Tổng rủi ro danh mục ${total_portfolio_risk_usd:.2f} ({total_portfolio_risk_pct:.2f}% Equity) vượt ngưỡng cảnh báo {warn_total_pct:.2f}%"
        )

    # P0: New-order daily risk gate. Never submit an order if the daily
    # broker history is unverified or the latched/projected loss cap is hit.
    # This does not affect management of existing positions or their SL/TP.
    daily_check = compute_and_persist_daily_loss_state(
        mt5,
        account,
        cfg_o,
        open_positions=existing_positions,
        open_sl_risk_usd=open_risk,
        pending_sl_risk_usd=pending_risk,
        new_order_risk_usd=new_risk,
    )
    if not daily_check.get("ok"):
        return {
            "ok": False, "submitted": False, "status": "BLOCKED_DAILY_HISTORY_UNVERIFIED",
            "message": str(daily_check.get("reason") or "Daily loss state unavailable"),
            "dailyRiskState": daily_check,
        }
    if daily_check.get("dailyLimitBreached") or daily_check.get("wouldExceedWithNewOrder"):
        return {
            "ok": False, "submitted": False, "status": "BLOCKED_DAILY_LOSS_LIMIT",
            "message": "Daily loss limit breached or projected risk exceeds remaining budget",
            "dailyRiskState": daily_check,
        }

    risk_metrics = {
        "sizingMode": "FIXED_LOT",
        "fixedLot": volume,
        "perTradeRiskUsd": round(new_risk, 2),
        "perTradeRiskPct": new_risk_pct,
        "totalPortfolioRiskUsd": total_portfolio_risk_usd,
        "totalPortfolioRiskPct": total_portfolio_risk_pct,
        "drawdownPct": cur_dd_pct,
        "freeMarginUsd": free_margin_val,
        "marginLevelPct": float(getattr(account, "margin_level", 0) or 0),
        "openPositionsCount": len(existing_positions),
        "dailyRiskState": daily_check if daily_check.get("ok") else None,
        "riskWarnings": risk_warnings,
    }

    req = {
        "action": int(getattr(mt5, "TRADE_ACTION_DEAL", 1)),
        "symbol": active_symbol,
        "volume": volume,
        "type": int(getattr(mt5, "ORDER_TYPE_BUY", 0) if is_buy else getattr(mt5, "ORDER_TYPE_SELL", 1)),
        "price": price,
        "sl": sl,
        "tp": tp,
        "deviation": 50,
        "magic": 270715,
        "comment": comment_tag[:31],
        "type_time": int(getattr(mt5, "ORDER_TIME_GTC", 0)),
        "type_filling": resolve_filling_mode(mt5, sym_info),
    }

    try:
        res = mt5.order_send(req)
    except Exception:
        return {
            "ok": False, "submitted": True, "uncertain": True,
            "message": "Broker order_send raised after submission attempt; reconcile broker positions/orders before retrying",
        }
    if res is None:
        return {
            "ok": False, "submitted": True, "uncertain": True,
            "message": "Broker order_send returned no response; stop automatic retries and reconcile MT5 positions/orders",
        }

    retcode = int(getattr(res, "retcode", -1))
    uncertain_transport_codes = {
        int(getattr(mt5, "TRADE_RETCODE_TIMEOUT", 10012)),
        int(getattr(mt5, "TRADE_RETCODE_CONNECTION", 10031)),
    }
    if retcode in uncertain_transport_codes:
        return {
            "ok": False, "submitted": True, "uncertain": True,
            "sizingMode": "FIXED_LOT",
            "riskWarnings": risk_warnings,
            "riskMetrics": risk_metrics,
            "retcode": retcode,
            "message": "Broker order transport timed out/disconnected; do not automatically retry until reconciled",
        }
    done_code = int(getattr(mt5, "TRADE_RETCODE_DONE", 10009))
    partial_code = int(getattr(mt5, "TRADE_RETCODE_DONE_PARTIAL", 10010))
    if retcode == int(getattr(mt5, "TRADE_RETCODE_PLACED", 10008)):
        return {
            "ok": False, "submitted": True, "pending": True,
            "uncertain": True, "retcode": retcode,
            "message": "Broker placed request but fill is unconfirmed; stop automatic retries and reconcile broker orders"
        }
    if retcode == partial_code:
        return {
            "ok": False, "submitted": True, "partialFill": True,
            "uncertain": True, "retcode": retcode,
            "requestedVolume": volume,
            "message": "Broker reported a partial entry fill; halt automatic retries and verify actual lot/SL/TP"
        }
    if retcode == done_code:
        reported_volume = getattr(res, "volume", None)
        if reported_volume is not None:
            try:
                filled_lot = float(reported_volume)
            except (TypeError, ValueError, OverflowError):
                filled_lot = float("nan")
            if not isfinite(filled_lot) or abs(filled_lot - volume) > max(1e-7, volume_step * 0.01):
                return {
                    "ok": False, "submitted": True, "uncertain": True,
                    "partialFill": bool(isfinite(filled_lot) and 0 < filled_lot < volume),
                    "requestedVolume": volume,
                    "retcode": retcode,
                    "message": "Broker DONE response has inconsistent executed volume; reconcile exposure before retrying",
                }
        max_retries = int(cfg_o.get("reconcileMaxRetries") or 3)
        retry_delay = float(cfg_o.get("reconcileRetryDelaySec") if cfg_o.get("reconcileRetryDelaySec") is not None else 0.05)
        readback_pos, order_ticket, deal_ticket = _reconcile_filled_order(
            mt5, active_symbol, side, volume, price, sl, tp, res, account,
            max_retries=max_retries, retry_delay_sec=retry_delay,
        )
        if readback_pos is None:
            return {
                "ok": False,
                "submitted": True,
                "uncertain": True,
                "status": "RECONCILIATION_PENDING",
                "orderTicket": order_ticket,
                "dealTicket": deal_ticket,
                "symbol": active_symbol,
                "side": side,
                "reconciled": False,
                "reconcileFreezeDca": True,
                "reconcileWarning": "Broker trả DONE nhưng chưa đọc được vị thế thực tế trên MT5 — khóa DCA và không tự gửi lại lệnh",
                "message": "RECONCILIATION_PENDING: Broker acknowledged DONE but actual position readback failed after retries; DCA frozen, manual/next-cycle reconciliation required",
                "retcode": retcode,
            }

        pos_ticket = int(getattr(readback_pos, "ticket", 0) or 0)
        pos_symbol = str(getattr(readback_pos, "symbol", "") or "")
        pos_side = "BUY" if int(getattr(readback_pos, "type", -1)) == 0 else ("SELL" if int(getattr(readback_pos, "type", -1)) == 1 else "UNKNOWN")
        broker_entry = float(getattr(readback_pos, "price_open", 0.0) or 0.0)
        broker_vol = float(getattr(readback_pos, "volume", 0.0) or 0.0)
        broker_sl = float(getattr(readback_pos, "sl", 0.0) or 0.0)
        broker_tp = float(getattr(readback_pos, "tp", 0.0) or 0.0)

        sl_dist_actual = round(abs(broker_entry - broker_sl), 2) if (broker_sl > 0 and broker_entry > 0) else 0.0
        tp_dist_actual = round(abs(broker_tp - broker_entry), 2) if (broker_tp > 0 and broker_entry > 0) else 0.0
        slippage_pts = round(abs(broker_entry - price), 2) if broker_entry > 0 else 0.0

        discrepancies = []
        if pos_symbol != active_symbol:
            discrepancies.append(f"symbol mismatch ({pos_symbol} != {active_symbol})")
        if pos_side != side:
            discrepancies.append(f"side mismatch ({pos_side} != {side})")
        if broker_vol <= 0 or abs(broker_vol - volume) > max(1e-7, volume_step * 0.01):
            discrepancies.append(f"volume mismatch ({broker_vol} != {volume})")
        if broker_sl <= 0 or abs(broker_sl - sl) > max(0.05, point * 5):
            discrepancies.append(f"SL mismatch ({broker_sl} != {sl})")
        if broker_tp <= 0 or abs(broker_tp - tp) > max(0.05, point * 5):
            discrepancies.append(f"TP mismatch ({broker_tp} != {tp})")
        if sl_dist_actual > MAX_STRUCTURAL_SL_DIST + 0.50 or sl_dist_actual < MIN_STRUCTURAL_SL_DIST - 0.50:
            discrepancies.append(f"post-fill SL distance {sl_dist_actual:.2f} USD/oz outside [6.0, 8.0] due to fill slippage ({slippage_pts:.2f})")

        reconcile_warning = "; ".join(discrepancies) if discrepancies else None
        freeze_dca = bool(discrepancies)

        if pos_ticket > 0:
            acc_login = int(getattr(account, "login", 0) or cfg_o.get("login") or 0)
            acc_server = str(getattr(account, "server", "") or cfg_o.get("server") or "DEFAULT").strip()
            comp_key, _ = _position_state_keys(acc_login, acc_server, pos_ticket, active_symbol)
            rec = {
                "accountLogin": acc_login,
                "server": acc_server,
                "symbol": active_symbol,
                "ticket": pos_ticket,
                "orderTicket": order_ticket,
                "dealTicket": deal_ticket,
                "side": pos_side,
                "status": "OPEN",
                "actualEntry": round(broker_entry, 2),
                "requestedEntry": round(price, 2),
                "slippagePts": slippage_pts,
                "initialSl": round(broker_sl, 2),
                "initialTp": round(broker_tp, 2),
                "initialR": round(sl_dist_actual if sl_dist_actual > 0 else initial_r, 4),
                "peak": round(broker_entry, 2),
                "reconciled": not freeze_dca,
                "reconcileFreezeDca": freeze_dca,
                "reconcileWarning": reconcile_warning,
                "createdAtMs": int(time.time() * 1000),
            }
            def _save_new_pos(s):
                s[comp_key] = rec
                return s
            _update_json_state(MANAGER_STATE_FILE, _save_new_pos)

        return {
            "ok": True,
            "status": "RECONCILED_WITH_DISCREPANCY" if freeze_dca else "RECONCILED",
            "ticket": pos_ticket,
            "orderTicket": order_ticket,
            "dealTicket": deal_ticket,
            "symbol": pos_symbol,
            "side": pos_side,
            "volume": broker_vol,
            "fillPrice": broker_entry,
            "sl": broker_sl,
            "tp": broker_tp,
            "slDistance": sl_dist_actual,
            "tpDistance": tp_dist_actual,
            "initialR": round(sl_dist_actual if sl_dist_actual > 0 else initial_r, 4),
            "slippagePts": slippage_pts,
            "reconciled": not freeze_dca,
            "reconcileFreezeDca": freeze_dca,
            "reconcileWarning": reconcile_warning,
            "slReason": str(cfg_o.get("slReason") or f"Cách Entry {sl_dist_actual} giá"),
            "tpReason": str(cfg_o.get("tpReason") or f"Cách Entry {tp_dist_actual} giá"),
            "entryReason": str(cfg_o.get("entryReason") or "Tín hiệu cấu trúc nến M15/M5"),
            "botName": str(cfg_o.get("botName") or "Bot Tự động + Gồng Trend Cấu Trúc V6"),
            "sizingMode": "FIXED_LOT",
            "riskWarnings": risk_warnings,
            "riskMetrics": risk_metrics,
            "retcode": retcode,
            "message": (
                f"Đã khớp lệnh {pos_side} {broker_vol} lot {pos_symbol} tại {broker_entry} "
                f"(SL: {broker_sl} [{cfg_o.get('slReason', 'Cấu trúc')}], TP: {broker_tp} [{cfg_o.get('tpReason', 'Vùng cản')}])"
                + (f" — CẢNH BÁO ĐỐI SOÁT: {reconcile_warning} (Tạm khóa DCA)" if reconcile_warning else "!")
            ),
        }
    return {
        "ok": False,
        "retcode": retcode,
        "message": f"Sàn từ chối lệnh (Mã {retcode}: {getattr(res, 'comment', '')}). Kiểm tra nút Algo Trading trên MT5!"
    }


def check_bot_signal_for_mode(signal, strategy_mode, required_side, min_conf=80):
    """DCA MUST use the same live closed-bar strategy gate as an original order."""
    mode = str(strategy_mode or "AUTO_REGIME").upper()
    if mode == "BOT_2_SIDEWAY" or str((signal or {}).get("strategyMode") or "").upper() == "BOT_2_SIDEWAY":
        return False, "No positive DCA in sideway mode"
    if not signal or not signal.get("allowed"):
        return False, "No eligible completed-bar setup for DCA"
    if signal.get("side") != required_side:
        return False, "DCA direction conflicts with confirmed entry plan"
    if int(signal.get("setupScore") or signal.get("confidence") or 0) < float(min_conf):
        return False, "DCA setup score below threshold"
    if mode != str(signal.get("requestedMode") or "").upper():
        return False, "DCA strategy mode and confirmed setup do not match"
    return True, "Confirmed same-direction entry setup: " + str(signal.get("patternName") or "")


def is_position_at_breakeven(pos):
    is_buy = int(getattr(pos, "type", 0)) == 0
    open_p = float(getattr(pos, "price_open", 0.0))
    sl_p = float(getattr(pos, "sl", 0.0) or 0.0)
    if sl_p <= 0:
        return False
    if is_buy:
        return sl_p >= open_p
    else:
        return sl_p <= open_p


def evaluate_positive_dca_decision(
    side,
    exec_price,
    last_entry_price,
    base_tp,
    current_dca_layers,
    max_layers,
    step_distance,
    strategy_mode,
    signal,
    last_signal_m15_ts,
    candidate_sl,
    h1_closed=None,
    h4_closed=None,
    min_conf=82.0,
    min_rr=1.6,
    round_trip_cost=0.08,
    stops_gap=0.01,
    bid_price=None,
    ask_price=None,
):
    """Section V (Task 4, 5, 7): Shared Positive DCA decision rule used by BOTH Live and Backtest.
    Returns structured decision with `ok`, `reasonCode`, `reason`, `dcaSl`, `dcaTp`, `initialR`, `netRr`.
    """
    mode = str(strategy_mode or "AUTO_REGIME").upper()
    sig = signal or {}
    sig_mode = str(sig.get("strategyMode") or "").upper()
    if mode == "BOT_2_SIDEWAY" or sig_mode == "BOT_2_SIDEWAY":
        return {"ok": False, "reasonCode": "DCA_DISABLED_IN_SIDEWAY", "reason": "No positive DCA in sideway mode"}
    if current_dca_layers >= max_layers:
        return {"ok": False, "reasonCode": "MAX_LAYERS_REACHED", "reason": f"Đã đạt số tầng DCA Dương tối đa ({current_dca_layers}/{max_layers} tầng phụ)."}
    fav_dist = (exec_price - last_entry_price) if side == "BUY" else (last_entry_price - exec_price)
    if fav_dist < max(1.2, float(step_distance)):
        return {
            "ok": False,
            "reasonCode": "STEP_DISTANCE_NOT_REACHED",
            "favorableDistance": round(fav_dist, 2),
            "reason": f"Khoảng cách từ lệnh trước (+{fav_dist:.2f} giá) chưa đạt bước tối thiểu (+{step_distance:.2f} giá).",
        }

    # Check M15 closed signal & regime
    if not sig.get("allowed"):
        if sig.get("status") == "WAIT_PULLBACK":
            return {"ok": False, "reasonCode": "WAIT_PULLBACK", "reason": str(sig.get("reason") or "WAIT_PULLBACK on M15/M5 structure")}
        if sig.get("subStatus") == "NEAR_OBSTACLE_INSUFFICIENT_RR":
            return {"ok": False, "reasonCode": "NEAR_OBSTACLE_OR_LOW_RR", "reason": str(sig.get("reason") or "Blocked by near H1/H4 obstacle")}
        return {"ok": False, "reasonCode": "NO_M15_SIGNAL", "reason": "No eligible completed-bar M15 setup for DCA"}
    sig_regime = str(sig.get("marketRegime") or "").upper()
    if sig_regime in ("RANGE", "TRANSITION", "UNKNOWN"):
        return {"ok": False, "reasonCode": "REGIME_OR_SIGNAL_CONFLICT", "reason": f"Market regime {sig_regime} not eligible for Positive DCA"}
    if sig.get("side") != side:
        return {"ok": False, "reasonCode": "REGIME_OR_SIGNAL_CONFLICT", "reason": "DCA direction conflicts with confirmed M15 entry plan"}
    if int(sig.get("setupScore") or sig.get("confidence") or 0) < float(min_conf):
        return {"ok": False, "reasonCode": "NO_M15_SIGNAL", "reason": "DCA setup score below threshold"}
    req_mode_sig = str(sig.get("requestedMode") or mode).upper()
    if mode != req_mode_sig and mode != "AUTO_REGIME":
        return {"ok": False, "reasonCode": "REGIME_OR_SIGNAL_CONFLICT", "reason": "DCA strategy mode and confirmed setup do not match"}
    sig_m15_ts = int(sig.get("closedM15Time") or 0)
    if sig_m15_ts <= int(last_signal_m15_ts or 0):
        return {"ok": False, "reasonCode": "DUPLICATE_OR_STALE_M15_SIGNAL", "reason": "DCA requires a NEW fully closed M15 signal after the last entry"}

    # Structural SL validation (6.0 - 8.0 USD/oz, never 6.8 fallback)
    if candidate_sl is None or not isfinite(float(candidate_sl)) or float(candidate_sl) <= 0:
        return {"ok": False, "reasonCode": "WAIT_PULLBACK", "reason": "WAIT_PULLBACK: Không xác định được SL cấu trúc M5 6–8 giá hợp lệ cho tầng DCA"}
    dca_sl = round(float(candidate_sl), 2)
    if (side == "BUY" and dca_sl >= exec_price) or (side == "SELL" and dca_sl <= exec_price):
        return {"ok": False, "reasonCode": "NO_TRADE_INVALID_STRUCTURE", "reason": "SL tầng DCA nằm sai phía so với giá vào"}
    dca_r = round(abs(exec_price - dca_sl), 4)
    if dca_r > MAX_STRUCTURAL_SL_DIST + 1e-6:
        return {"ok": False, "reasonCode": "WAIT_PULLBACK", "reason": f"WAIT_PULLBACK: DCA structural SL ({dca_r:.2f}) exceeds {MAX_STRUCTURAL_SL_DIST} USD/oz"}
    if dca_r < MIN_STRUCTURAL_SL_DIST - 1e-6:
        return {"ok": False, "reasonCode": "WAIT_PULLBACK", "reason": f"WAIT_PULLBACK: DCA structural SL ({dca_r:.2f}) below {MIN_STRUCTURAL_SL_DIST} USD/oz"}

    # Check TP & near obstacles on closed H1/H4 without modifying base position TP
    near_obs_price = None
    tp_from_obstacle = None
    if h1_closed and h4_closed:
        tp_sel = select_tp_with_near_obstacle_check(
            side, exec_price, dca_sl, h1_closed, h4_closed, min_rr=min_rr, round_trip_cost=round_trip_cost
        )
        if not tp_sel.get("ok"):
            return {"ok": False, "reasonCode": "NEAR_OBSTACLE_OR_LOW_RR", "reason": f"DCA blocked by near H1/H4 obstacle ({tp_sel.get('nearestObstacle')})"}
        near_obs_price = tp_sel.get("nearestObstacle")
        tp_from_obstacle = float(tp_sel["tp"])

    dca_tp = float(sig.get("tp") or tp_from_obstacle or 0.0)
    if base_tp and float(base_tp) > 0:
        btp = float(base_tp)
        gross_to_btp = (btp - exec_price) if side == "BUY" else (exec_price - btp)
        net_rr_to_btp = (gross_to_btp - round_trip_cost) / dca_r
        blocked_by_near = (
            near_obs_price is not None
            and ((side == "BUY" and float(near_obs_price) < btp) or (side == "SELL" and float(near_obs_price) > btp))
        )
        if net_rr_to_btp >= min_rr - 1e-6 and not blocked_by_near:
            dca_tp = btp
        elif tp_from_obstacle is not None:
            dca_tp = tp_from_obstacle

    if dca_tp <= 0 or (side == "BUY" and dca_tp <= exec_price) or (side == "SELL" and dca_tp >= exec_price):
        return {"ok": False, "reasonCode": "NEAR_OBSTACLE_OR_LOW_RR", "reason": "Missing valid DCA target price"}

    gross_reward = (dca_tp - exec_price) if side == "BUY" else (exec_price - dca_tp)
    net_rr = round((gross_reward - round_trip_cost) / dca_r, 2)
    if net_rr < min_rr - 1e-6:
        return {"ok": False, "reasonCode": "NEAR_OBSTACLE_OR_LOW_RR", "reason": f"DCA net R:R ({net_rr:.2f}) below {min_rr:.2f} after costs"}

    b_px = float(bid_price if bid_price is not None else exec_price)
    a_px = float(ask_price if ask_price is not None else exec_price)
    if (side == "BUY" and not (dca_sl < b_px - stops_gap and dca_tp > a_px + stops_gap)) or (
        side == "SELL" and not (dca_sl > a_px + stops_gap and dca_tp < b_px - stops_gap)
    ):
        return {"ok": False, "reasonCode": "BROKER_STOP_LEVEL_INVALID", "reason": "DCA SL/TP violates broker stop/freeze level"}

    return {
        "ok": True,
        "reasonCode": "ELIGIBLE",
        "reason": f"Confirmed same-direction entry setup: {sig.get('patternName', mode)}",
        "dcaSl": round(dca_sl, 2),
        "dcaTp": round(dca_tp, 2),
        "initialR": dca_r,
        "netRr": net_rr,
        "closedM15Time": sig_m15_ts,
        "favorableDistance": round(fav_dist, 2),
    }


def evaluate_and_execute_positive_dca(mt5, active_symbol, pos_list, live_analysis, dca_cfg, force_manual=False, execute=False):
    """Section IV (Task 2 & Task 3): Positive DCA with strict 4-part account|server|symbol|ticket isolation & full pre-send broker verification."""
    if _is_manager_state_corrupted():
        return {
            "eligible": False,
            "executed": False,
            "reasonCode": "STATE_FILE_CORRUPTED",
            "currentLayers": 0,
            "reason": "DCA bị chặn: File trạng thái vị thế (.runtime/v6-position-manager-state.json) bị hỏng định dạng JSON."
        }

    # Re-read live positions from broker if available so we never rely on stale snapshot
    live_pos_list = pos_list
    if callable(getattr(mt5, "positions_get", None)):
        try:
            fresh_pos = mt5.positions_get(symbol=active_symbol)
            if fresh_pos is None:
                return {
                    "eligible": False,
                    "executed": False,
                    "reasonCode": "POSITIONS_READ_FAILED",
                    "currentLayers": 0,
                    "reason": "DCA bị chặn: Không đọc được danh sách vị thế trực tiếp từ MT5 (positions_get returned None)."
                }
            if len(fresh_pos) > 0:
                live_pos_list = fresh_pos
        except Exception:
            return {
                "eligible": False,
                "executed": False,
                "reasonCode": "POSITIONS_READ_FAILED",
                "currentLayers": 0,
                "reason": "DCA bị chặn: Lỗi khi truy vấn positions_get từ MT5."
            }

    sym_positions = [p for p in (live_pos_list or []) if str(getattr(p, "symbol", "")) == active_symbol]
    if not sym_positions:
        return {
            "eligible": False,
            "executed": False,
            "reasonCode": "NO_BASE_POSITION",
            "currentLayers": 0,
            "reason": "Chưa có lệnh gốc nào đang mở trên " + active_symbol + "."
        }

    mgr_state = _load_manager_state()
    account_dca = mt5.account_info() if callable(getattr(mt5, "account_info", None)) else None
    dca_login = int(getattr(account_dca, "login", 0) or dca_cfg.get("accountLogin") or dca_cfg.get("login") or 5201362)
    dca_server = str(getattr(account_dca, "server", "") or dca_cfg.get("server") or "DBGMarkets-Live").strip()
    if any(k in dca_cfg for k in ("login", "expectedLogin", "server", "expectedServer", "accountMode", "expectedAccountMode")) and account_dca is not None:
        ok_bind, bind_err = verify_mt5_account_binding(mt5, dca_cfg, account=account_dca)
        if not ok_bind:
            return {
                "eligible": False,
                "executed": False,
                "reasonCode": "ACCOUNT_BINDING_MISMATCH",
                "currentLayers": max(0, len(sym_positions) - 1),
                "reason": f"DCA bị chặn do sai lệch tài khoản/server: {bind_err}"
            }

    first_type = int(getattr(sym_positions[0], "type", 0))
    side = "BUY" if first_type == 0 else "SELL"
    adopt_manual = bool(dca_cfg.get("semiAutoAdoptManual", False))

    verified_state_items = {}
    for p in sym_positions:
        raw_p_magic = getattr(p, "magic", None)
        p_magic = int(raw_p_magic) if raw_p_magic is not None else 270715
        if p_magic != 270715 and not (p_magic == 0 and adopt_manual):
            return {
                "eligible": False,
                "executed": False,
                "reasonCode": "NON_BOT_POSITION_DETECTED",
                "currentLayers": len(sym_positions) - 1,
                "reason": f"DCA bị chặn: Phát hiện vị thế #{p.ticket} (magic={p_magic}) không thuộc quyền quản lý của Bot V6."
            }
        if int(getattr(p, "type", 0)) != first_type:
            return {
                "eligible": False,
                "executed": False,
                "reasonCode": "OPPOSITE_POSITION_HEDGE_DETECTED",
                "currentLayers": len(sym_positions) - 1,
                "reason": "Đang có lệnh ngược chiều (Hedge), tạm khóa DCA Dương."
            }
        comp_k, leg3_k = _position_state_keys(dca_login, dca_server, p.ticket, active_symbol)
        # Task 2: NEVER look up bare ticket str(p.ticket)! Only use 4-part key or verified same-account/server/symbol 3-part key.
        st_item = mgr_state.get(comp_k)
        if st_item is None and leg3_k in mgr_state:
            cand_leg = mgr_state[leg3_k]
            if (
                isinstance(cand_leg, dict)
                and int(cand_leg.get("accountLogin") or 0) == dca_login
                and servers_match(str(cand_leg.get("server") or ""), dca_server)
                and str(cand_leg.get("symbol") or active_symbol) == active_symbol
            ):
                st_item = cand_leg
        if st_item is not None and isinstance(st_item, dict):
            if int(st_item.get("accountLogin") or dca_login) != dca_login or not servers_match(str(st_item.get("server") or dca_server), dca_server) or str(st_item.get("symbol") or active_symbol) != active_symbol:
                st_item = None
        if st_item is None:
            # Attempt verified MT5 history recovery for this position
            hist_rec = _recover_verified_initial_sl_from_mt5_history(mt5, p, active_symbol, dca_login, dca_server)
            if hist_rec.get("ok"):
                st_item = {
                    "accountLogin": dca_login,
                    "server": dca_server,
                    "symbol": active_symbol,
                    "ticket": int(p.ticket),
                    "initialSl": hist_rec["initialSl"],
                    "initialR": hist_rec["initialR"],
                    "stateUnverified": False,
                    "reconcileFreezeDca": False,
                    "reconciled": True,
                }
            elif dca_cfg.get("requireVerifiedStateForDca", False) or any(
                isinstance(v, dict) and int(v.get("ticket") or 0) == int(p.ticket) and (int(v.get("accountLogin") or 0) != dca_login or not servers_match(str(v.get("server") or ""), dca_server))
                for v in mgr_state.values()
            ):
                return {
                    "eligible": False,
                    "executed": False,
                    "reasonCode": "STATE_UNVERIFIED_MISSING_RECORD",
                    "currentLayers": len(sym_positions) - 1,
                    "reason": f"DCA bị chặn: Không tìm thấy bản ghi trạng thái xác thực 4 thành phần ({comp_k}) cho vị thế #{p.ticket}."
                }
            else:
                st_item = {}

        if (
            st_item.get("stateUnverified")
            or st_item.get("reconcileFreezeDca")
            or st_item.get("reconciled") is False
            or st_item.get("dcaUncertainFreeze")
        ):
            return {
                "eligible": False,
                "executed": False,
                "reasonCode": "STATE_UNVERIFIED",
                "currentLayers": len(sym_positions) - 1,
                "reason": f"DCA bị chặn: Lệnh #{p.ticket} ở trạng thái STATE_UNVERIFIED hoặc có cảnh báo đối soát ({st_item.get('reconcileWarning') or st_item.get('lastRejectionReason') or 'UNCERTAIN_FREEZE'})."
            }
        if st_item and ("initialR" in st_item) and float(st_item.get("initialR") or 0.0) <= 0:
            return {
                "eligible": False,
                "executed": False,
                "reasonCode": "MISSING_VERIFIED_INITIAL_R",
                "currentLayers": len(sym_positions) - 1,
                "reason": f"DCA bị chặn: Thiếu initialR đã xác minh cho vị thế #{p.ticket}."
            }
        if float(getattr(p, "profit", 0.0)) <= 0:
            return {
                "eligible": False,
                "executed": False,
                "reasonCode": "POSITION_NOT_PROFITABLE",
                "currentLayers": len(sym_positions) - 1,
                "reason": f"Lệnh #{p.ticket} chưa có lãi dương (${getattr(p, 'profit', 0):.2f}). Nguyên tắc DCA Dương: Chỉ nhồi khi lệnh hiện tại đang DƯƠNG!"
            }
        verified_state_items[int(p.ticket)] = st_item

    max_layers = int(dca_cfg.get("maxLayers") or 2)
    current_dca_layers = max(0, len(sym_positions) - 1)
    if current_dca_layers >= max_layers:
        return {
            "eligible": False,
            "executed": False,
            "reasonCode": "MAX_LAYERS_REACHED",
            "currentLayers": current_dca_layers,
            "reason": f"Đã đạt số tầng DCA Dương tối đa ({current_dca_layers}/{max_layers} tầng phụ)."
        }

    sorted_pos = sorted(sym_positions, key=lambda x: int(getattr(x, "time", 0)))
    latest_pos = sorted_pos[-1]
    base_pos = sorted_pos[0]
    last_entry = float(getattr(latest_pos, "price_open", 0.0))

    pos_cur_px = float(getattr(latest_pos, "price_current", 0.0) or 0.0)
    tick_now = mt5.symbol_info_tick(active_symbol) if callable(getattr(mt5, "symbol_info_tick", None)) else None
    if pos_cur_px > 0 and not dca_cfg.get("useLiveTickPriceOnly", False):
        cur_price = pos_cur_px
        bid_px = pos_cur_px
        ask_px = pos_cur_px
    elif tick_now is not None:
        cur_price = float(tick_now.ask if side == "BUY" else tick_now.bid)
        bid_px = float(tick_now.bid)
        ask_px = float(tick_now.ask)
    else:
        cur_price = pos_cur_px
        bid_px = cur_price
        ask_px = cur_price

    favorable_dist = (cur_price - last_entry) if side == "BUY" else (last_entry - cur_price)
    min_step_dist = float(dca_cfg.get("stepDistance") or 4.5)

    all_at_be = all(is_position_at_breakeven(p) for p in sym_positions)
    if not all_at_be:
        latest_st = verified_state_items.get(int(latest_pos.ticket)) or {}
        raw_latest_sl = float(getattr(latest_pos, "sl", 0) or 0.0)
        sl_on_risk_side = raw_latest_sl > 0 and ((side == "BUY" and raw_latest_sl < last_entry) or (side == "SELL" and raw_latest_sl > last_entry))
        latest_r_val = latest_st.get("initialR") or (abs(last_entry - raw_latest_sl) if sl_on_risk_side else None)
        if not latest_r_val or float(latest_r_val) <= 0:
            return {"eligible": False, "executed": False, "reasonCode": "STATE_UNVERIFIED", "currentLayers": current_dca_layers, "reason": "STATE_UNVERIFIED: Không xác định được initialR của lệnh trước để kiểm tra BE cho DCA."}
        latest_r = float(latest_r_val)
        if execute and favorable_dist >= latest_r:
            for old_p in sym_positions:
                if not is_position_at_breakeven(old_p):
                    result = move_sl_to_breakeven(mt5, int(getattr(old_p, "ticket", 0)))
                    if not result.get("ok"):
                        return {"eligible": False, "executed": False, "reasonCode": "PRIOR_LAYER_NOT_AT_BE", "reason": "Broker rejected BE on an earlier layer"}
            current_positions = mt5.positions_get(symbol=active_symbol) or []
            all_at_be = bool(current_positions) and len(current_positions) == len(sym_positions) and all(is_position_at_breakeven(p) for p in current_positions)
            if not all_at_be:
                return {"eligible": False, "executed": False, "reasonCode": "PRIOR_LAYER_NOT_AT_BE", "reason": "Could not confirm BE on every layer from broker"}
        else:
            return {
                "eligible": False,
                "executed": False,
                "reasonCode": "BEFORE_BE",
                "currentLayers": current_dca_layers,
                "favorableDistance": round(favorable_dist, 2),
                "requiredDistance": round(latest_r, 2),
                "reason": f"Lệnh trước đang dương (+{favorable_dist:.2f} giá) nhưng CHƯA kéo SL về Hòa vốn 1R (+{latest_r:.2f} giá)."
            }

    strategy_mode = str(dca_cfg.get("strategyMode") or "AUTO_REGIME")
    min_conf = float(dca_cfg.get("minConfidence") or 82)
    bot_ok, bot_reason = check_bot_signal_for_mode(live_analysis, strategy_mode, side, min_conf)
    latest_entry_time_ms = int(getattr(latest_pos, "time", 0) or 0) * 1000
    last_dca_m15_ts = max(
        [latest_entry_time_ms] + [int((verified_state_items.get(int(p.ticket)) or {}).get("lastDcaClosedM15Time") or 0) for p in sym_positions]
    )
    if bot_ok and int((live_analysis or {}).get("closedM15Time", 0)) <= last_dca_m15_ts:
        bot_ok, bot_reason = False, "DCA requires a NEW fully closed M15 signal after the last entry"
    if not bot_ok:
        return {
            "eligible": False,
            "executed": False,
            "reasonCode": "NO_M15_SIGNAL",
            "currentLayers": current_dca_layers,
            "reason": f"Lệnh đầu đã kéo BE & đang dương, đang chờ tín hiệu chuẩn của Bot: {bot_reason}"
        }
    if favorable_dist < max(1.2, min_step_dist):
        return {
            "eligible": False,
            "executed": False,
            "reasonCode": "STEP_DISTANCE_NOT_REACHED",
            "currentLayers": current_dca_layers,
            "reason": f"Đã có tín hiệu Bot ({bot_reason}) nhưng khoảng cách từ lệnh trước (+{favorable_dist:.2f} giá) chưa đạt bước tối thiểu (+{min_step_dist:.2f} giá)."
        }

    if not dca_cfg.get("enabled", False):
        return {
            "eligible": True,
            "executed": False,
            "reasonCode": "DCA_SWITCH_DISABLED",
            "currentLayers": current_dca_layers,
            "reason": f"ĐỦ ĐIỀU KIỆN DCA DƯƠNG TẦNG #{current_dca_layers + 1} (Lệnh đầu đã kéo BE + {bot_reason}), nhưng công tắc DCA Dương đang TẮT."
        }

    if not execute and not dca_cfg.get("strictPreviewValidation", False):
        return {
            "eligible": True,
            "executed": False,
            "reasonCode": "PREVIEW_ONLY",
            "currentLayers": current_dca_layers,
            "reason": "Eligible for DCA; preview only (no broker action)"
        }

    broker_info = mt5.symbol_info(active_symbol) if callable(getattr(mt5, "symbol_info", None)) else None
    if broker_info is None:
        return {"eligible": False, "executed": False, "reasonCode": "MISSING_SYMBOL_INFO", "reason": "Broker symbol specs unavailable for DCA"}
    point_dca = float(getattr(broker_info, "point", 0.01) or 0.01)
    stops_gap_dca = max(
        point_dca,
        float(getattr(broker_info, "trade_stops_level", 0) or 0) * point_dca,
        float(getattr(broker_info, "trade_freeze_level", 0) or 0) * point_dca,
    )
    dec = evaluate_positive_dca_decision(
        side=side,
        exec_price=cur_price,
        last_entry_price=last_entry,
        base_tp=float(getattr(base_pos, "tp", 0.0) or 0.0),
        current_dca_layers=current_dca_layers,
        max_layers=max_layers,
        step_distance=min_step_dist,
        strategy_mode=strategy_mode,
        signal=live_analysis,
        last_signal_m15_ts=last_dca_m15_ts,
        candidate_sl=(live_analysis or {}).get("sl"),
        min_conf=min_conf,
        min_rr=1.6,
        round_trip_cost=float(dca_cfg.get("roundTripCostPts") or 0.0),
        stops_gap=stops_gap_dca,
        bid_price=bid_px,
        ask_price=ask_px,
    )
    if not dec["ok"]:
        return {
            "eligible": False,
            "executed": False,
            "reasonCode": dec["reasonCode"],
            "currentLayers": current_dca_layers,
            "reason": dec["reason"],
        }
    dca_sl = dec["dcaSl"]
    dca_tp = dec["dcaTp"]
    if not execute:
        return {
            "eligible": True,
            "executed": False,
            "reasonCode": "PREVIEW_ONLY",
            "currentLayers": current_dca_layers,
            "reason": "Eligible for DCA; preview only (no broker action)"
        }

    confirmed = mt5.positions_get(symbol=active_symbol) or []
    if len(confirmed) != len(sym_positions) or not all(is_position_at_breakeven(p) for p in confirmed):
        return {"eligible": False, "executed": False, "reasonCode": "PRIOR_LAYER_NOT_AT_BE", "reason": "DCA blocked: broker BE not confirmed"}

    base_vol = float(getattr(base_pos, "volume", 0.02))
    next_layer_num = current_dca_layers + 1
    step = float(getattr(broker_info, "volume_step", 0.01) or 0.01)
    min_vol = float(getattr(broker_info, "volume_min", 0.01) or 0.01)
    max_vol = float(getattr(broker_info, "volume_max", 100.0) or 100.0)
    if dca_cfg.get("fixedDcaLot") is not None and float(dca_cfg.get("fixedDcaLot") or 0) > 0:
        dca_vol = float(dca_cfg["fixedDcaLot"])
        steps = dca_vol / step
        if dca_vol < min_vol - 1e-9 or dca_vol > max_vol + 1e-9 or abs(steps - round(steps)) > 1e-5:
            return {"eligible": False, "executed": False, "reasonCode": "INVALID_DCA_LOT", "reason": f"Cấu hình Fixed DCA Lot ({dca_vol}) không hợp lệ với quy định broker"}
    elif dca_cfg.get("dcaUseBaseLot") is True:
        dca_vol = base_vol
    else:
        return {
            "eligible": False,
            "executed": False,
            "reasonCode": "MISSING_FIXED_DCA_LOT",
            "reason": "DCA yêu cầu cấu hình rõ FIXED_DCA_LOT hoặc bật dcaUseBaseLot=true (không tự lấy lot gốc nhân 0.5).",
        }
    if dca_vol < min_vol or dca_vol <= 0:
        return {"eligible": False, "executed": False, "reasonCode": "INVALID_DCA_LOT", "reason": "Next DCA volume below broker minimum; skip layer"}

    order_res = execute_order(
        mt5, active_symbol,
        {
            "side": side,
            "volume": dca_vol,
            "explicitSlPrice": dca_sl,
            "explicitTpPrice": dca_tp,
            "structuralInvalidationPrice": (live_analysis or {}).get("structuralInvalidationPrice"),
            "maxRiskPercent": min(HARD_MAX_RISK_PER_TRADE_PCT, float(dca_cfg.get("maxRiskPercent") or 0.5)),
            "maxPortfolioRiskPercent": min(HARD_MAX_PORTFOLIO_RISK_PCT, float(dca_cfg.get("maxPortfolioRiskPercent") or HARD_MAX_PORTFOLIO_RISK_PCT)),
            "maxSpreadPoints": float(dca_cfg.get("maxSpreadPoints") or 65.0),
            "minRewardRisk": 1.6,
            "liveAuthorized": bool(dca_cfg.get("liveAuthorized", False)),
            "liveArmed": bool(dca_cfg.get("liveArmed", False)),
            "explicitLiveGateConfirmed": bool(dca_cfg.get("explicitLiveGateConfirmed", False)),
        },
        comment_tag=f"DCA_PLUS_L{next_layer_num}_{side}"
    )

    # Task 2.10 & 2.12: If order_res is uncertain/timeout/partialFill, freeze DCA on all open positions of this symbol immediately!
    if order_res.get("uncertain") or order_res.get("partialFill") or order_res.get("reconcileFreezeDca"):
        def _freeze_symbol_dca(s):
            for p_open in sym_positions:
                ck, _ = _position_state_keys(dca_login, dca_server, p_open.ticket, active_symbol)
                rec_o = dict(s.get(ck) or {})
                rec_o["accountLogin"] = dca_login
                rec_o["server"] = dca_server
                rec_o["symbol"] = active_symbol
                rec_o["ticket"] = int(p_open.ticket)
                rec_o["dcaUncertainFreeze"] = True
                rec_o["reconcileFreezeDca"] = True
                rec_o["reconcileWarning"] = order_res.get("message") or "Uncertain DCA order result — freeze automatic DCA retries"
                s[ck] = rec_o
            return s
        _update_json_state(MANAGER_STATE_FILE, _freeze_symbol_dca)
    elif order_res.get("ok"):
        sig_m15_now = int((live_analysis or {}).get("closedM15Time") or 0)
        def _record_dca_m15_ts(s):
            for p_open in sym_positions:
                ck, _ = _position_state_keys(dca_login, dca_server, p_open.ticket, active_symbol)
                if ck in s and isinstance(s[ck], dict):
                    s[ck]["lastDcaClosedM15Time"] = sig_m15_now
            return s
        _update_json_state(MANAGER_STATE_FILE, _record_dca_m15_ts)

    return {
        "eligible": True,
        "executed": Boolean(order_res.get("ok")),
        "submitted": Boolean(order_res.get("submitted")),
        "uncertain": Boolean(order_res.get("uncertain")),
        "reasonCode": "EXECUTED" if order_res.get("ok") else ("UNCERTAIN_FROZEN" if order_res.get("uncertain") else "ORDER_REJECTED"),
        "currentLayers": next_layer_num if order_res.get("ok") else current_dca_layers,
        "orderResult": order_res,
        "reason": f"[{bot_reason}] " + order_res.get("message", "Đã thực thi DCA Dương.")
    }


def Boolean(val):
    return bool(val)


def close_position_by_ticket(mt5, ticket_id):
    """Explicit-ticket gold close only; fail closed on ambiguous tickets and readback."""
    if (isinstance(ticket_id, bool) or
            not isinstance(ticket_id, (int, str)) or
            not str(ticket_id).isascii() or
            not str(ticket_id).isdecimal() or
            str(ticket_id).startswith("0")):
        return {"ok": False, "closedCount": 0, "message": "Phải chọn chính xác ticket nguyên dương để đóng."}
    ticket = int(ticket_id)
    if ticket <= 0:
        return {"ok": False, "closedCount": 0, "message": "Ticket không hợp lệ."}
    try:
        matches = mt5.positions_get(ticket=ticket)
    except Exception:
        matches = None
    if matches is None:
        return {"ok": False, "closedCount": 0, "message": f"Không xác minh được broker ticket #{ticket}."}
    pos = next((p for p in matches if int(getattr(p, "ticket", 0)) == ticket), None)
    if pos is None:
        return {"ok": False, "closedCount": 0, "message": f"Vị thế #{ticket} không còn mở."}

    symbol = str(pos.symbol)
    if not symbol.upper().startswith(("XAUUSD", "GOLD")):
        return {"ok": False, "closedCount": 0, "message": f"Ticket #{ticket} không thuộc mã vàng XAUUSD/GOLD."}
    volume = float(getattr(pos, "volume", 0) or 0)
    info = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)
    if not isfinite(volume) or volume <= 0 or info is None or tick is None:
        return {"ok": False, "closedCount": 0, "message": f"Thiếu khối lượng/symbol/quote hợp lệ cho #{ticket}."}
    buy = int(pos.type) == 0
    price = float(tick.bid if buy else tick.ask)
    if not isfinite(price) or price <= 0:
        return {"ok": False, "closedCount": 0, "message": f"Broker quote không hợp lệ cho #{ticket}."}
    request = {
        "action": int(getattr(mt5, "TRADE_ACTION_DEAL", 1)),
        "symbol": symbol,
        "position": ticket,
        "volume": volume,
        "type": int(getattr(mt5, "ORDER_TYPE_SELL", 1) if buy else getattr(mt5, "ORDER_TYPE_BUY", 0)),
        "price": price,
        "deviation": 50,
        "magic": int(getattr(pos, "magic", 270715) or 270715),
        "comment": "CLOSE_WEB_V6",
        "type_time": int(getattr(mt5, "ORDER_TIME_GTC", 0)),
        "type_filling": resolve_filling_mode(mt5, info),
    }
    result = mt5.order_send(request)
    if result is None or int(getattr(result, "retcode", -1)) not in (10009, 10010):
        return {"ok": False, "closedCount": 0, "message": f"Broker chưa xác nhận lệnh đóng #{ticket}."}

    try:
        after_positions = mt5.positions_get(ticket=ticket)
    except Exception:
        after_positions = None
    if after_positions is None:
        return {"ok": False, "closedCount": 0, "submitted": True, "uncertain": True,
                "message": f"Đã gửi lệnh đóng #{ticket} nhưng broker readback thất bại; không được gửi lặp tự động."}
    remaining_pos = next((p for p in after_positions if int(getattr(p, "ticket", 0)) == ticket), None)
    if remaining_pos is not None:
        remaining = float(getattr(remaining_pos, "volume", 0) or 0)
        return {"ok": False, "closedCount": 0, "submitted": True,
                "partialFill": isfinite(remaining) and 0 <= remaining < volume,
                "remainingVolume": remaining,
                "message": f"Broker vẫn còn vị thế #{ticket} ({remaining} lot); không xác nhận đóng toàn bộ."}
    return {"ok": True, "closedCount": 1, "ticket": ticket, "verifiedClosed": True,
            "message": f"Broker xác minh ticket #{ticket} ({symbol}) đã đóng hoàn toàn."}


def move_sl_to_breakeven(mt5, ticket_id):
    """Only tighten stops; operator-wide BE may touch V6-owned gold positions only."""
    if ticket_id:
        ticket_pos = _read_position_by_ticket(mt5, ticket_id)
        positions = [ticket_pos] if ticket_pos is not None else []
    else:
        positions = [
            p for p in (mt5.positions_get() or [])
            if ("XAUUSD" in str(getattr(p, "symbol", "")).upper()
                or str(getattr(p, "symbol", "")).upper().startswith("GOLD"))
            and int(getattr(p, "magic", 0) or 0) == 270715
        ]
    if not positions:
        return {"ok": False, "message": "Không có vị thế V6 phù hợp để dời SL."}
    success = 0
    failures = []
    for pos in positions:
        if not str(getattr(pos, "symbol", "")).upper().startswith(("XAUUSD", "GOLD")):
            failures.append(f"#{pos.ticket}: non-gold position rejected")
            continue
        digits = int(getattr(mt5.symbol_info(str(pos.symbol)), "digits", 2))
        buy = int(pos.type) == 0
        entry = float(pos.price_open)
        old_sl = float(getattr(pos, "sl", 0.0) or 0.0)
        be_price = round(entry + (0.25 if buy else -0.25), digits)
        if old_sl > 0 and ((buy and old_sl >= be_price) or (not buy and old_sl <= be_price)):
            success += 1
            continue
        result = modify_position_sl_tp(mt5, pos, be_price, None,
                                       "Operator BE (never loosen)")
        if result.get("ok"):
            success += 1
        else:
            failures.append(f"#{pos.ticket}: {result.get('message', 'broker rejected')}")
    return {
        "ok": success > 0 and not failures,
        "movedOrAlreadyProtected": success,
        "message": f"BE verified for {success}/{len(positions)} ticket(s)" +
                   ("; FAIL: " + "; ".join(failures) if failures else "")
    }


def simulate_position_lifecycle(plan, future_m5_bars, future_m15_bars=None, prior_m5_bars=None, cfg=None):
    """Zero-look-ahead, bar-by-bar position simulator calling the exact same
    `evaluate_position_management_step()` used by live trading (Section 2 & 4.2):
    - No future-bar filtering (every valid entry is executed and tracked honestly).
    - No max(...) profit boosting.
    - No 96-bar arbitrary forced close: if future_m5_bars ends while position is still open,
      marks `isOpenAtEnd = True` and `exitType = "OPEN_AT_DATASET_END"` for separate reporting.
    - Properly handles Bid/Ask for BUY vs SELL when `askSpreadPts` is supplied.
    - Deducts spread, commission, slippage, and overnight swap costs transparently.
    - Conservative rule when a single bar spans both SL and TP (`AMBIGUOUS_BAR_SL`).
    """
    cfg_s = cfg or {}
    if not isinstance(plan, dict):
        return {"ok": False, "error": "INVALID_SIMULATION_PLAN", "message": "Simulation plan must be a dict"}
    raw_side = str(plan.get("side") or "").strip().upper()
    raw_entry = plan.get("entryReference") if plan.get("entryReference") is not None else plan.get("entry")
    raw_sl = plan.get("sl")
    raw_tp = plan.get("tp")
    if raw_side not in ("BUY", "SELL") or raw_entry is None or raw_sl is None or raw_tp is None:
        return {"ok": False, "error": "INVALID_SIMULATION_PLAN", "message": "Missing required side/entryReference/sl/tp in simulation plan"}
    try:
        entry = float(raw_entry)
        sl = float(raw_sl)
        tp = float(raw_tp)
    except (TypeError, ValueError):
        return {"ok": False, "error": "INVALID_SIMULATION_PLAN", "message": "Non-numeric entryReference/sl/tp in simulation plan"}
    buy = (raw_side == "BUY")
    side = raw_side
    if not (isfinite(entry) and isfinite(sl) and isfinite(tp)) or entry <= 0 or sl <= 0 or tp <= 0:
        return {"ok": False, "error": "INVALID_SIMULATION_PLAN", "message": "Nonpositive or non-finite entryReference/sl/tp"}
    if (buy and not (sl < entry < tp)) or (not buy and not (tp < entry < sl)):
        return {"ok": False, "error": "INVALID_SIMULATION_PLAN", "message": f"Invalid SL/TP side alignment for {side}: entry={entry}, sl={sl}, tp={tp}"}
    raw_init_r = plan.get("initialR")
    init_r = float(raw_init_r) if (raw_init_r is not None and float(raw_init_r) > 0) else abs(entry - sl)
    if not isfinite(init_r) or init_r <= 0:
        return {"ok": False, "error": "INVALID_SIMULATION_PLAN", "message": "Invalid initialR in simulation plan"}
    strat_used = str(plan.get("strategyMode") or "BOT_1_TREND").upper()
    is_sw = (strat_used == "BOT_2_SIDEWAY")
    spike_dist = max(5.0, float(cfg_s.get("m15SpikeTrailDist") or 10.0))

    ask_spread_pts = max(0.0, float(cfg_s.get("askSpreadPts") or 0.0))
    cost_pts = max(0.0, float(cfg_s.get("roundTripCostPts") if cfg_s.get("roundTripCostPts") is not None else DEFAULT_ROUND_TRIP_COST_PTS))
    swap_per_day_pts = float(cfg_s.get("swapPtsPerDay") or 0.0)

    cur_sl = sl
    at_be = False
    one_r_reached_ts = 0
    be_reached_ts = 0
    pre_be_trailed = False
    peak = entry
    exit_price = entry
    entry_ts = int(plan.get("closedM15Time", 0))
    exit_ts = int(future_m5_bars[-1][4]) if future_m5_bars else entry_ts
    exit_type = "OPEN_AT_DATASET_END"
    is_open_at_end = False
    ambiguous_bar = False
    sl_history = [cur_sl]

    history_m5 = list(prior_m5_bars or [])
    m15_by_close = list(future_m15_bars or [])

    for fb in future_m5_bars:
        op_b, hi_bid, lo_bid, cl_bid, ts_b = float(fb[0]), float(fb[1]), float(fb[2]), float(fb[3]), int(fb[4])
        # BUY exits on Bid; SELL exits on Ask (Bid + ask_spread_pts)
        op_exec = op_b if buy else (op_b + ask_spread_pts)
        hi_exec = hi_bid if buy else (hi_bid + ask_spread_pts)
        lo_exec = lo_bid if buy else (lo_bid + ask_spread_pts)
        cl_exec = cl_bid if buy else (cl_bid + ask_spread_pts)

        # Gap handling at bar open: if M5 bar opens beyond SL or TP, fill at bar open price (gap slippage)
        if (buy and op_exec <= cur_sl) or (not buy and op_exec >= cur_sl):
            exit_price = op_exec
            exit_ts = ts_b
            exit_type = "SL_GAP"
            break
        if (buy and tp > 0 and op_exec >= tp) or (not buy and tp > 0 and op_exec <= tp):
            exit_price = op_exec
            exit_type = "TP_GAP"
            exit_ts = ts_b
            break

        sl_hit = (lo_exec <= cur_sl) if buy else (hi_exec >= cur_sl)
        tp_hit = (hi_exec >= tp) if buy else (lo_exec <= tp)

        if sl_hit and tp_hit:
            exit_price = cur_sl
            exit_ts = ts_b
            ambiguous_bar = True
            exit_type = "AMBIGUOUS_BAR_SL" if not at_be else "AMBIGUOUS_BAR_TRAIL"
            break
        if sl_hit:
            exit_price = cur_sl
            exit_ts = ts_b
            if not at_be:
                exit_type = "SL_HIT_REDUCED" if pre_be_trailed else "SL_HIT"
            elif abs(cur_sl - entry) <= 0.45:
                exit_type = "BE_SAVED"
            else:
                exit_type = "TREND_TRAIL_EXIT"
            break
        if tp_hit:
            exit_price = tp
            exit_ts = ts_b
            exit_type = "SIDEWAY_TP" if is_sw else "TP_HIT"
            break

        # Candle closed without hitting SL or TP -> update extreme and call shared evaluate_position_management_step()
        history_m5.append(fb)
        bar_favorable_extreme = hi_bid if buy else lo_exec
        peak = max(peak, bar_favorable_extreme) if buy else min(peak, bar_favorable_extreme)
        if one_r_reached_ts == 0:
            fav_exc = (peak - entry) if buy else (entry - peak)
            if fav_exc >= init_r - 1e-6:
                one_r_reached_ts = ts_b + 300_000
        closed_m15_now = [m for m in m15_by_close if int(m[4]) + 900_000 <= ts_b + 300_000]

        step_res = evaluate_position_management_step(
            side=side,
            entry=entry,
            current_price=cl_exec,
            current_sl=cur_sl,
            current_tp=tp,
            initial_r=init_r,
            favorable_extreme=peak,
            confirmed_m5=history_m5,
            confirmed_m15=closed_m15_now,
            strategy_mode=strat_used,
            config={
                "beAtOneR": bool(cfg_s.get("beAtOneR", True)),
                "beTriggerRMultiple": float(cfg_s.get("beTriggerRMultiple") or 1.0),
                "beBufferPts": float(cfg_s.get("beBufferPts") if cfg_s.get("beBufferPts") is not None else 0.25),
                "roundTripCostPts": cost_pts,
                "beCompensateCost": bool(cfg_s.get("beCompensateCost", True)),
                "enableM5StructuralTrail": bool(cfg_s.get("enableM5StructuralTrail", True)),
                "enablePeakLock": bool(cfg_s.get("enablePeakLock", True)),
                "m15SpikeTrailDist": spike_dist,
                "minBrokerStopGap": float(cfg_s.get("minBrokerStopGap") or 0.80),
                "sidewayEnableM5Trail": bool(cfg_s.get("sidewayEnableM5Trail", True)),
                "sidewayEnablePeakLock": bool(cfg_s.get("sidewayEnablePeakLock", False)),
            },
        )
        peak = step_res["favorableExtreme"]
        if step_res["shouldModifySl"]:
            cur_sl = step_res["newSl"]
            sl_history.append(cur_sl)
            if not at_be and step_res["atBeAfter"] and be_reached_ts == 0:
                be_reached_ts = ts_b + 300_000
            at_be = step_res["atBeAfter"]
            if not at_be:
                pre_be_trailed = True
    else:
        is_open_at_end = True
        if future_m5_bars:
            last_b = future_m5_bars[-1]
            exit_price = float(last_b[3]) if buy else (float(last_b[3]) + ask_spread_pts)
            exit_ts = int(last_b[4])
        exit_type = "OPEN_AT_DATASET_END"

    days_held = max(0, (exit_ts - entry_ts) // (86400 * 1000)) if exit_ts > entry_ts else 0
    swap_cost_pts = round(days_held * swap_per_day_pts, 2)
    total_cost_pts = round(cost_pts + swap_cost_pts, 2)

    raw_pts = round((exit_price - entry) if buy else (entry - exit_price), 2)
    net_pts = round(raw_pts - total_cost_pts, 2)
    peak_pts = round((peak - entry) if buy else (entry - peak), 2)
    r_multiple = round(net_pts / init_r, 3)

    return {
        "ok": True,
        "side": side,
        "entry": round(entry, 2),
        "entryReference": round(entry, 2),
        "initialSl": round(sl, 2),
        "finalSl": round(cur_sl, 2),
        "tp": round(tp, 2),
        "initialR": round(init_r, 4),
        "exit": round(exit_price, 2),
        "exitTs": exit_ts,
        "exitType": exit_type,
        "isOpenAtEnd": is_open_at_end,
        "ambiguousBar": ambiguous_bar,
        "atBe": at_be,
        "oneRReachedTs": one_r_reached_ts,
        "beReachedTs": be_reached_ts,
        "preBeTrailed": pre_be_trailed,
        "rawPts": raw_pts,
        "costPts": total_cost_pts,
        "pts": net_pts,
        "netPts": net_pts,
        "rMultiple": r_multiple,
        "peakPts": peak_pts,
        "slHistory": sl_history,
    }


def _classify_session_utc(ts_ms):
    hr = datetime.datetime.fromtimestamp(ts_ms / 1000.0, tz=datetime.timezone.utc).hour
    if 0 <= hr < 7:
        return "ASIAN"
    if 7 <= hr < 13:
        return "LONDON"
    return "NEW_YORK"


def _compute_metrics_for_trade_slice(closed_trades, open_trades=None, base_lot=0.05, starting_balance=4131.83, usd_per_price_per_lot=100.0):
    """Compute honest performance metrics for a subset of settled trades (Section 4.3):
    - Separates wins, breakevens, and losses; NEVER combines `wins + breakevens` into `winRatePct`.
    - Reports netPts, netPnlUsd, expectancyR, profitFactor, maxDrawdownPts/Pct, maxConsecutiveLosses.
    """
    open_list = list(open_trades or [])
    n = len(closed_trades)
    if n == 0:
        return {
            "status": "NO_TRADES",
            "closedTradeCount": 0,
            "openAtEndCount": len(open_list),
            "wins": 0,
            "breakevens": 0,
            "losses": 0,
            "winRatePct": 0.0,
            "breakevenRatePct": 0.0,
            "lossRatePct": 0.0,
            "netPts": 0.0,
            "netPnlUsd": 0.0,
            "expectancyR": 0.0,
            "profitFactor": 0.0,
            "maxDrawdownPts": 0.0,
            "maxDrawdownUsd": 0.0,
            "maxDrawdownPct": 0.0,
            "maxConsecutiveLosses": 0,
            "unrealizedOpenPts": round(sum(float(t.get("pts", 0.0)) for t in open_list), 2),
        }

    wins = [t for t in closed_trades if float(t["pts"]) > 0.50]
    bes = [t for t in closed_trades if -0.50 <= float(t["pts"]) <= 0.50]
    losses = [t for t in closed_trades if float(t["pts"]) < -0.50]

    win_rate_pct = round((len(wins) / n) * 100.0, 2)
    be_rate_pct = round((len(bes) / n) * 100.0, 2)
    loss_rate_pct = round((len(losses) / n) * 100.0, 2)

    gross_profit = sum(float(t["pts"]) for t in closed_trades if float(t["pts"]) > 0)
    gross_loss = abs(sum(float(t["pts"]) for t in closed_trades if float(t["pts"]) < 0))
    pf = round(gross_profit / gross_loss, 2) if gross_loss > 0 else (99.0 if gross_profit > 0 else 0.0)
    net_pts = round(sum(float(t["pts"]) for t in closed_trades), 2)
    net_usd = round(net_pts * float(base_lot) * float(usd_per_price_per_lot), 2)
    expectancy_r = round(sum(float(t["rMultiple"]) for t in closed_trades) / n, 3)

    eq_pts = 0.0
    peak_pts = 0.0
    max_dd_pts = 0.0
    cur_loss_streak = 0
    max_loss_streak = 0

    for t in closed_trades:
        p_val = float(t["pts"])
        eq_pts += p_val
        peak_pts = max(peak_pts, eq_pts)
        max_dd_pts = max(max_dd_pts, peak_pts - eq_pts)
        if p_val < -0.50:
            cur_loss_streak += 1
            max_loss_streak = max(max_loss_streak, cur_loss_streak)
        else:
            cur_loss_streak = 0

    max_dd_usd = round(max_dd_pts * float(base_lot) * float(usd_per_price_per_lot), 2)
    max_dd_pct = round((max_dd_usd / max(1.0, float(starting_balance))) * 100.0, 2)
    unrealized_open_pts = round(sum(float(t.get("pts", 0.0)) for t in open_list), 2)
    unrealized_open_usd = round(unrealized_open_pts * float(base_lot) * float(usd_per_price_per_lot), 2)
    mtm_eq_pts = eq_pts + unrealized_open_pts
    mtm_dd_pts = max(max_dd_pts, max(0.0, peak_pts - mtm_eq_pts))
    mtm_dd_usd = round(mtm_dd_pts * float(base_lot) * float(usd_per_price_per_lot), 2)
    mtm_dd_pct = round((mtm_dd_usd / max(1.0, float(starting_balance))) * 100.0, 2)

    return {
        "status": "OK",
        "closedTradeCount": n,
        "openAtEndCount": len(open_list),
        "wins": len(wins),
        "breakevens": len(bes),
        "losses": len(losses),
        "winRatePct": win_rate_pct,
        "breakevenRatePct": be_rate_pct,
        "lossRatePct": loss_rate_pct,
        "netPts": net_pts,
        "netPnlUsd": net_usd,
        "expectancyR": expectancy_r,
        "profitFactor": pf,
        "maxDrawdownPts": round(max_dd_pts, 2),
        "maxDrawdownUsd": max_dd_usd,
        "maxDrawdownPct": max_dd_pct,
        "closedTradesMaxDrawdownPct": max_dd_pct,
        "equityMarkToMarketDrawdownUsd": mtm_dd_usd,
        "equityMarkToMarketDrawdownPct": mtm_dd_pct,
        "maxConsecutiveLosses": max_loss_streak,
        "unrealizedOpenPts": unrealized_open_pts,
        "unrealizedOpenUsd": unrealized_open_usd,
    }


def _build_portfolio_scenario_comparison(
    closed_trades,
    open_positions_at_end,
    base_lot,
    starting_balance,
    usd_per_price_per_lot,
    margin_call_level_pct=100.0,
    stop_out_level_pct=50.0,
    market_m5_bars=None,
    market_spread_pts=0.16,
    simulate_stop_out=False,
    liquidation_rule="LARGEST_LOSS_FIRST",
):
    """Section V (Task 6): Build chronological multi-position portfolio timelines for:
    - Scenario A (without DCA): Base positions only.
    - Scenario B (with Positive DCA): Base positions + simulated DCA layers.
    Tracks Balance (updated ONLY on position close), Realized P/L, Floating P/L, Equity, Used Margin,
    Free Margin, Margin Level, Max Drawdown (including intra-trade floating Equity drawdown from DCA),
    base-closes-before-DCA and DCA-closes-before-base, and Margin Call / Stop-Out events.
    """
    if type(simulate_stop_out) is not bool:
        raise ValueError("simulate_stop_out must be an explicit boolean")
    if simulate_stop_out and str(liquidation_rule).upper() not in ("FIFO", "LARGEST_LOSS_FIRST"):
        raise ValueError("Unsupported broker stop-out liquidation rule")
    for threshold in (margin_call_level_pct, stop_out_level_pct):
        if not isinstance(threshold, (int, float)) or isinstance(threshold, bool):
            raise ValueError("Margin thresholds must be numeric")
        if not isfinite(float(threshold)) or float(threshold) <= 0:
            raise ValueError("Margin thresholds must be finite and positive")
    all_trade_records = list(closed_trades or []) + list(open_positions_at_end or [])

    def _run_timeline(include_dca):
        positions = []
        dca_rej_totals = {
            "waitPullback": 0,
            "insufficientRrOrNearObstacle": 0,
            "insufficientMargin": 0,
            "beforeBe": 0,
            "priorLayerNotAtBe": 0,
            "noM15SignalOrConflict": 0,
        }
        for t in all_trade_records:
            rc = t.get("dcaRejectedCounts") or {}
            for k in dca_rej_totals:
                dca_rej_totals[k] += int(rc.get(k, 0))
            t_vol = float(t.get("volume") or base_lot)
            t_is_open_end = bool(t.get("isOpenAtEnd", False))
            t_net_usd = round(float(t["pts"]) * t_vol * float(usd_per_price_per_lot), 2)
            t_spread_pts = float(t.get("spreadPts") if t.get("spreadPts") is not None else 0.16)
            t_comm_pts = float(t.get("commissionPts") if t.get("commissionPts") is not None else 0.04)
            t_slip_pts = float(t.get("slippagePts") if t.get("slippagePts") is not None else 0.04)
            t_swap_pts = float(t.get("swapPts") if t.get("swapPts") is not None else 0.0)
            positions.append({
                "ticket": int(t.get("ticket") or 0),
                "layer": 0,
                "side": t["side"],
                "entryTs": int(t["tsMs"]),
                "exitTs": int(t["exitTsMs"]),
                "entryPrice": float(t["entry"]),
                "exitPrice": float(t["exit"]),
                "fixedLot": t_vol,
                "volume": t_vol,
                "initialSl": float(t["sl"]),
                "initialR": float(t["initialR"]),
                "finalSl": float(t["finalSl"]),
                "tp": float(t["tp"]),
                "beReachedTs": int(t.get("beReachedTs") or 0),
                "exitType": t["exitType"],
                "exitReason": t.get("reason") or t["exitType"],
                "isOpenAtEnd": t_is_open_end,
                "pts": float(t["pts"]),
                "rMultiple": float(t["rMultiple"]),
                "spreadUsd": round(t_spread_pts * t_vol * float(usd_per_price_per_lot), 2),
                "commissionUsd": round(t_comm_pts * t_vol * float(usd_per_price_per_lot), 2),
                "slippageUsd": round(t_slip_pts * t_vol * float(usd_per_price_per_lot), 2),
                "swapUsd": round(t_swap_pts * t_vol * float(usd_per_price_per_lot), 2),
                "realizedPnlUsd": 0.0 if t_is_open_end else t_net_usd,
                "unrealizedPnlUsd": t_net_usd if t_is_open_end else 0.0,
                "netPnlUsd": t_net_usd,
                "marginUsd": float(t.get("marginUsd") or 0.0),
                "marginFormula": t.get("marginFormula") or "BROKER_CALC_MARGIN_OR_CONTRACT_LEVERAGE",
            })
            if include_dca:
                for dl in (t.get("dcaLayersSimulated") or []):
                    dl_vol = float(dl["fixedDcaLot"])
                    dl_open_end = bool(dl.get("isOpenAtEnd", False))
                    dl_net_usd = float(dl["netPnlUsd"])
                    dl_spread_pts = float(dl.get("spreadPts") if dl.get("spreadPts") is not None else 0.16)
                    dl_comm_pts = float(dl.get("commissionPts") if dl.get("commissionPts") is not None else 0.04)
                    dl_slip_pts = float(dl.get("slippagePts") if dl.get("slippagePts") is not None else 0.04)
                    dl_swap_pts = float(dl.get("swapPts") if dl.get("swapPts") is not None else 0.0)
                    positions.append({
                        "ticket": int(dl["ticket"]),
                        "layer": int(dl["layer"]),
                        "side": dl["side"],
                        "entryTs": int(dl["entryTs"]),
                        "exitTs": int(dl["exitTs"]),
                        "entryPrice": float(dl["entryPrice"]),
                        "exitPrice": float(dl["exitPrice"]),
                        "fixedLot": dl_vol,
                        "volume": dl_vol,
                        "initialSl": float(dl["initialSl"]),
                        "initialR": float(dl["initialR"]),
                        "finalSl": float(dl["finalSl"]),
                        "tp": float(dl["tp"]),
                        "beReachedTs": int(dl.get("beReachedTs") or 0),
                        "exitType": dl["exitType"],
                        "exitReason": dl.get("exitType"),
                        "isOpenAtEnd": dl_open_end,
                        "pts": float(dl["netPts"]),
                        "rMultiple": float(dl["rMultiple"]),
                        "spreadUsd": round(dl_spread_pts * dl_vol * float(usd_per_price_per_lot), 2),
                        "commissionUsd": round(dl_comm_pts * dl_vol * float(usd_per_price_per_lot), 2),
                        "slippageUsd": round(dl_slip_pts * dl_vol * float(usd_per_price_per_lot), 2),
                        "swapUsd": round(dl_swap_pts * dl_vol * float(usd_per_price_per_lot), 2),
                        "realizedPnlUsd": 0.0 if dl_open_end else dl_net_usd,
                        "unrealizedPnlUsd": dl_net_usd if dl_open_end else 0.0,
                        "netPnlUsd": dl_net_usd,
                        "marginUsd": float(dl["marginUsd"]),
                        "marginFormula": dl.get("marginFormula") or "BROKER_CALC_MARGIN_OR_CONTRACT_LEVERAGE",
                    })

        event_price_map = {}
        for p in positions:
            event_price_map[p["entryTs"]] = p["entryPrice"]
            event_price_map[p["exitTs"]] = p["exitPrice"]

        # Historical M5 OHLC rows are stamped at BAR OPEN. A closing Bid only becomes
        # available at open_ts + 300_000; never use a future bar to value an earlier event.
        # Optional input preserves the older event-proxy diagnostic for isolated tests.
        m5_marks = []
        for bar in (market_m5_bars or []):
            try:
                close_time = int(bar[4]) + 300_000
                bid_close = float(bar[3])
                if close_time > 0 and isfinite(bid_close) and bid_close > 0:
                    m5_marks.append((close_time, bid_close, float(bar[1]), float(bar[2])))
            except (IndexError, TypeError, ValueError):
                continue
        m5_marks.sort(key=lambda row: row[0])
        trade_event_times = {ts for p in positions for ts in (p["entryTs"], p["exitTs"])}
        if trade_event_times:
            first_event, last_event = min(trade_event_times), max(trade_event_times)
            m5_event_times = {row[0] for row in m5_marks if first_event <= row[0] <= last_event}
        else:
            m5_event_times = set()
        event_times = sorted(trade_event_times | m5_event_times)
        mark_index = 0
        last_mark_time = None
        last_mark_bid = None
        fresh_m5_snapshots = 0
        stale_m5_snapshots = 0
        intrabar_stress_snapshots = 0
        intrabar_stopout_risk_snapshots = 0
        intrabar_min_margin_level_pct = None
        spread_for_marks = max(0.0, float(market_spread_pts or 0.0))
        balance = float(starting_balance)
        peak_balance = balance
        max_bal_dd_usd = 0.0
        peak_equity = balance
        max_eq_dd_usd = 0.0
        max_used_margin = 0.0
        min_free_margin = balance
        min_margin_level_pct = 0.0
        margin_call_count = 0
        stop_out_count = 0
        margin_call_breach_snapshots = 0
        stop_out_breach_snapshots = 0
        # Record the pre-liquidation breach: closing a position can restore
        # margin before the post-event counters are sampled.
        stop_out_trigger_events = 0
        stop_out_price_unverified_snapshots = 0
        stop_out_unverified_potential_breaches = 0
        margin_call_active = False
        stop_out_active = False
        timeline_snapshots = []

        for t_ev in event_times:
            while mark_index < len(m5_marks) and m5_marks[mark_index][0] <= t_ev:
                last_mark_time, last_mark_bid = m5_marks[mark_index][0:2]
                mark_index += 1
            # 1) Settle positions closing at t_ev (skip positions already force-liquidated at an earlier timestamp)
            for p in positions:
                if p["exitTs"] == t_ev and not p.get("isOpenAtEnd", False) and not p.get("_settledByStopOut", False):
                    balance = round(balance + p["realizedPnlUsd"], 2)
            realized_pnl_cum = round(balance - float(starting_balance), 2)
            peak_balance = max(peak_balance, balance)
            max_bal_dd_usd = max(max_bal_dd_usd, round(peak_balance - balance, 2))

            # 2) Identify positions currently open at t_ev (entryTs <= t_ev < exitTs, or isOpenAtEnd at final timestamp)
            open_now = [
                p for p in positions
                if (p["entryTs"] <= t_ev < p["exitTs"]) or (p.get("isOpenAtEnd", False) and p["exitTs"] == t_ev)
            ]
            used_margin = round(sum(p["marginUsd"] for p in open_now), 2)
            total_vol = round(sum(p["volume"] for p in open_now), 4)
            total_risk_usd = round(sum(p["initialR"] * p["volume"] * float(usd_per_price_per_lot) for p in open_now), 2)

            # Revalue every still-open position on EVERY CLOSED M5 bar, not only
            # at entry/exit. Use a common Bid (and Ask for SELL) across the portfolio.
            # M5 closing prices cannot capture intrabar peaks; label this explicitly.
            floating_pnl = 0.0
            mark_bid = last_mark_bid
            mark_ask = (mark_bid + spread_for_marks) if mark_bid is not None else None
            mark_age_ms = (t_ev - last_mark_time) if last_mark_time is not None else None
            if mark_bid is not None:
                if mark_age_ms is not None and mark_age_ms <= 900_000:
                    price_source = "CLOSED_M5_BID_ASK"
                    fresh_m5_snapshots += 1
                else:
                    price_source = "STALE_M5_BID_ASK_UNVERIFIED"
                    stale_m5_snapshots += 1
                for p_open in open_now:
                    close_px = mark_bid if p_open["side"] == "BUY" else mark_ask
                    pts_f = (close_px - p_open["entryPrice"]) if p_open["side"] == "BUY" else (p_open["entryPrice"] - close_px)
                    # Entry spread is represented by Bid/Ask; charge estimated
                    # round-trip commission and slippage once, not the spread twice.
                    pending_cost_usd = p_open["commissionUsd"] + p_open["slippageUsd"]
                    floating_pnl += pts_f * p_open["volume"] * float(usd_per_price_per_lot) - pending_cost_usd
            else:
                price_source = "POSITION_EVENT_PRICE_PROXY_UNVERIFIED"
                ref_px = event_price_map.get(t_ev)
                if ref_px is not None:
                    for p_open in open_now:
                        if p_open.get("isOpenAtEnd", False) and p_open["exitTs"] == t_ev:
                            floating_pnl += p_open["unrealizedPnlUsd"]
                        elif p_open["entryTs"] < t_ev:
                            pts_f = (ref_px - p_open["entryPrice"]) if p_open["side"] == "BUY" else (p_open["entryPrice"] - ref_px)
                            floating_pnl += pts_f * p_open["volume"] * float(usd_per_price_per_lot)
            floating_pnl = round(floating_pnl, 2)
            equity = round(balance + floating_pnl, 2)
            # Diagnostic ONLY: use adverse extrema from a FULLY CLOSED M5 bar
            # for positions open throughout that bar. Never value an earlier
            # event with an unclosed bar and never claim broker liquidation.
            intrabar_margin_level = None
            intrabar_stopout_risk = False
            if used_margin > 0 and last_mark_time == t_ev and mark_index > 0:
                bar_close_ts, _, bar_high, bar_low = m5_marks[mark_index - 1]
                bar_open_ts = bar_close_ts - 300_000
                if (isfinite(bar_high) and isfinite(bar_low) and bar_high >= bar_low > 0):
                    full_bar_positions = [
                        p for p in positions
                        if p["entryTs"] <= bar_open_ts and p["exitTs"] >= bar_close_ts
                    ]
                    # Report only if every margin-bearing exposure has been
                    # present for this entire bar; mixed entry/exit bars need
                    # higher-resolution data and must stay unverified.
                    if full_bar_positions and len(full_bar_positions) == len(open_now):
                        adverse_floating = 0.0
                        for p in full_bar_positions:
                            adverse_exit = bar_low if p["side"] == "BUY" else bar_high + spread_for_marks
                            adverse_pts = ((adverse_exit - p["entryPrice"]) if p["side"] == "BUY"
                                           else (p["entryPrice"] - adverse_exit))
                            adverse_floating += (
                                adverse_pts * p["volume"] * float(usd_per_price_per_lot)
                                - p["commissionUsd"] - p["slippageUsd"]
                            )
                        stress_equity = balance + adverse_floating
                        intrabar_margin_level = round(100.0 * stress_equity / used_margin, 2)
                        intrabar_stopout_risk = intrabar_margin_level <= float(stop_out_level_pct)
                        intrabar_stress_snapshots += 1
                        if intrabar_stopout_risk:
                            intrabar_stopout_risk_snapshots += 1
                        if intrabar_min_margin_level_pct is None:
                            intrabar_min_margin_level_pct = intrabar_margin_level
                        else:
                            intrabar_min_margin_level_pct = min(
                                intrabar_min_margin_level_pct, intrabar_margin_level
                            )
            free_margin = round(equity - used_margin, 2)
            margin_level = round((equity / used_margin) * 100.0, 2) if used_margin > 0 else 0.0

            # Capture the full risk state BEFORE simulated liquidation.
            # Otherwise worst free margin, used margin and margin level can be
            # falsely improved by the very liquidation those extrema describe.
            pre_liquidation_margin_level = margin_level if used_margin > 0 else None
            pre_liquidation_used_margin = used_margin
            pre_liquidation_free_margin = free_margin
            max_used_margin = max(max_used_margin, pre_liquidation_used_margin)
            min_free_margin = min(min_free_margin, pre_liquidation_free_margin)
            if pre_liquidation_margin_level is not None:
                min_margin_level_pct = (
                    pre_liquidation_margin_level if min_margin_level_pct == 0.0
                    else min(min_margin_level_pct, pre_liquidation_margin_level)
                )
            # A forced-liquidation price may only come from the M5 bar that
            # actually CLOSED at this event. A stale M5 mark or position-event
            # proxy is insufficient evidence to simulate an executed stop-out.
            stop_out_closed_m5_usable = bool(
                price_source == "CLOSED_M5_BID_ASK"
                and last_mark_time == t_ev
                and mark_bid is not None and isfinite(mark_bid)
                and mark_ask is not None and isfinite(mark_ask)
            )
            stop_out_price_unverified_here = bool(
                simulate_stop_out and used_margin > 0 and not stop_out_closed_m5_usable
            )
            stop_out_unverified_breach_here = bool(
                stop_out_price_unverified_here and margin_level <= float(stop_out_level_pct)
            )
            if stop_out_price_unverified_here:
                stop_out_price_unverified_snapshots += 1
            if stop_out_unverified_breach_here:
                stop_out_unverified_potential_breaches += 1
            stop_out_triggered_here = bool(
                simulate_stop_out and used_margin > 0 and stop_out_closed_m5_usable
                and margin_level <= float(stop_out_level_pct)
            )
            if stop_out_triggered_here:
                stop_out_trigger_events += 1
            # Scenario only. A closed M5 mark does not prove the broker's
            # real intrabar liquidation sequence or execution price.
            if stop_out_triggered_here:
                def _pos_float_pnl(po):
                    # Only the closed-M5 executable Bid/Ask is admissible.
                    c_px = mark_bid if po["side"] == "BUY" else mark_ask
                    pts_x = (c_px - po["entryPrice"]) if po["side"] == "BUY" else (po["entryPrice"] - c_px)
                    return pts_x * po["volume"] * float(usd_per_price_per_lot) - po["commissionUsd"] - po["slippageUsd"] - po["swapUsd"]

                if str(liquidation_rule).upper() == "FIFO":
                    liq_candidates = sorted(open_now, key=lambda x: (x["entryTs"], x["ticket"]))
                else:
                    liq_candidates = sorted(open_now, key=lambda x: (_pos_float_pnl(x), x["entryTs"]))

                for liq_p in liq_candidates:
                    if used_margin <= 0 or margin_level > float(stop_out_level_pct):
                        break
                    liq_px = mark_bid if liq_p["side"] == "BUY" else mark_ask
                    liq_pts = (liq_px - liq_p["entryPrice"]) if liq_p["side"] == "BUY" else (liq_p["entryPrice"] - liq_px)
                    liq_net_usd = round(_pos_float_pnl(liq_p), 2)
                    liq_p["exitTs"] = t_ev
                    liq_p["exitPrice"] = round(float(liq_px), 2)
                    liq_p["exitType"] = "STOP_OUT_LIQUIDATED"
                    liq_p["exitReason"] = f"Forced Stop-Out liquidation ({liquidation_rule}) at Margin Level {margin_level:.2f}% <= {float(stop_out_level_pct):.1f}%"
                    liq_p["isOpenAtEnd"] = False
                    liq_p["pts"] = round(liq_pts, 2)
                    # Recompute scenario R using the actual forced-exit net P/L,
                    # not the original planned exit's stale R multiple.
                    initial_risk_usd = (liq_p["initialR"] * liq_p["volume"]
                                        * float(usd_per_price_per_lot))
                    liq_p["rMultiple"] = round(liq_net_usd / initial_risk_usd, 3) if initial_risk_usd > 0 else 0.0
                    liq_p["realizedPnlUsd"] = liq_net_usd
                    liq_p["unrealizedPnlUsd"] = 0.0
                    liq_p["netPnlUsd"] = liq_net_usd
                    liq_p["_settledByStopOut"] = True
                    balance = round(balance + liq_net_usd, 2)
                    open_now = [op for op in open_now if op is not liq_p]
                    used_margin = round(sum(op["marginUsd"] for op in open_now), 2)
                    total_vol = round(sum(op["volume"] for op in open_now), 4)
                    total_risk_usd = round(sum(op["initialR"] * op["volume"] * float(usd_per_price_per_lot) for op in open_now), 2)
                    floating_pnl = round(sum(_pos_float_pnl(op) for op in open_now), 2)
                    equity = round(balance + floating_pnl, 2)
                    free_margin = round(equity - used_margin, 2)
                    margin_level = round((equity / used_margin) * 100.0, 2) if used_margin > 0 else 0.0
                realized_pnl_cum = round(balance - float(starting_balance), 2)
                peak_balance = max(peak_balance, balance)
                max_bal_dd_usd = max(max_bal_dd_usd, round(peak_balance - balance, 2))
            if used_margin > 0:
                min_margin_level_pct = margin_level if min_margin_level_pct == 0.0 else min(min_margin_level_pct, margin_level)
                call_breached = margin_level <= float(margin_call_level_pct)
                stop_breached = margin_level <= float(stop_out_level_pct)
                if call_breached:
                    margin_call_breach_snapshots += 1
                    if not margin_call_active:
                        margin_call_count += 1
                if stop_breached:
                    stop_out_breach_snapshots += 1
                    if not stop_out_active:
                        stop_out_count += 1
                margin_call_active = call_breached
                stop_out_active = stop_breached
            else:
                # A fully flat account ends any previous breach interval.
                margin_call_active = False
                stop_out_active = False
            max_used_margin = max(max_used_margin, used_margin)
            min_free_margin = min(min_free_margin, free_margin)
            peak_equity = max(peak_equity, equity)
            max_eq_dd_usd = max(max_eq_dd_usd, round(peak_equity - equity, 2))
            timeline_snapshots.append({
                "ts": t_ev,
                "balanceUsd": balance,
                "realizedPnlUsd": realized_pnl_cum,
                "equityUsd": equity,
                "floatingPnlUsd": floating_pnl,
                "usedMarginUsd": used_margin,
                "freeMarginUsd": free_margin,
                "marginLevelPct": margin_level,
                "openVolume": total_vol,
                "openRiskUsd": total_risk_usd,
                "openCount": len(open_now),
                "priceSource": price_source,
                "markBid": round(mark_bid, 5) if mark_bid is not None else None,
                "markAsk": round(mark_ask, 5) if mark_ask is not None else None,
                "markAgeMs": mark_age_ms,
                "intrabarAdverseMarginLevelPct": intrabar_margin_level,
                "intrabarStopOutRiskObserved": intrabar_stopout_risk,
                "preLiquidationMarginLevelPct": pre_liquidation_margin_level,
                "preLiquidationUsedMarginUsd": pre_liquidation_used_margin,
                "preLiquidationFreeMarginUsd": pre_liquidation_free_margin,
                "simulatedStopOutTriggeredHere": stop_out_triggered_here,
                "stopOutClosedM5PriceUsable": stop_out_closed_m5_usable,
                "stopOutPriceUnverifiedHere": stop_out_price_unverified_here,
                "stopOutUnverifiedPotentialBreachHere": stop_out_unverified_breach_here,
            })

        settled_positions = [p for p in positions if not p.get("isOpenAtEnd", False)]
        open_end_positions = [p for p in positions if p.get("isOpenAtEnd", False)]
        n_pos = len(settled_positions)
        wins = [p for p in settled_positions if p["pts"] > 0.50]
        bes = [p for p in settled_positions if -0.50 <= p["pts"] <= 0.50]
        losses = [p for p in settled_positions if p["pts"] < -0.50]
        gp_usd = sum(p["realizedPnlUsd"] for p in settled_positions if p["realizedPnlUsd"] > 0)
        gl_usd = abs(sum(p["realizedPnlUsd"] for p in settled_positions if p["realizedPnlUsd"] < 0))
        pf = round(gp_usd / gl_usd, 2) if gl_usd > 0 else (99.0 if gp_usd > 0 else 0.0)
        exp_r = round(sum(p["rMultiple"] for p in settled_positions) / n_pos, 3) if n_pos > 0 else 0.0
        cur_streak = 0
        max_streak = 0
        for p in sorted(settled_positions, key=lambda x: x["exitTs"]):
            if p["pts"] < -0.50:
                cur_streak += 1
                max_streak = max(max_streak, cur_streak)
            else:
                cur_streak = 0

        unrealized_end_usd = round(sum(p["unrealizedPnlUsd"] for p in open_end_positions), 2)
        if last_mark_time is not None and timeline_snapshots:
            # End-of-test floating and equity must agree with the same market-price
            # snapshots used for the drawdown path, not stale trade-level estimates.
            unrealized_end_usd = timeline_snapshots[-1]["floatingPnlUsd"]
            ending_equity_usd = timeline_snapshots[-1]["equityUsd"]
        else:
            ending_equity_usd = round(balance + unrealized_end_usd, 2)
        pricing_coverage = round(100.0 * fresh_m5_snapshots / len(timeline_snapshots), 2) if timeline_snapshots else 0.0
        # Report a checkable accounting identity; liquidation is a scenario,
        # not a broker-verified event or a change to the base trade summary.
        equity_reconciliation_delta = round(ending_equity_usd - (balance + unrealized_end_usd), 2)
        # Reconcile EVERY point of the portfolio time series, not just the
        # final balance. An interim inconsistency can hide risk at stop-out.
        max_timeline_equity_delta = round(max((
            abs(float(snap["equityUsd"]) - (
                float(snap["balanceUsd"]) + float(snap["floatingPnlUsd"])
            )) for snap in timeline_snapshots
        ), default=0.0), 2)
        max_timeline_free_margin_delta = round(max((
            abs(float(snap["freeMarginUsd"]) - (
                float(snap["equityUsd"]) - float(snap["usedMarginUsd"])
            )) for snap in timeline_snapshots
        ), default=0.0), 2)
        timeline_reconciled = (
            isfinite(max_timeline_equity_delta)
            and isfinite(max_timeline_free_margin_delta)
            and max_timeline_equity_delta <= 0.01
            and max_timeline_free_margin_delta <= 0.01
        )
        return {
            "scenarioAccountingDeltaUsd": equity_reconciliation_delta,
            "scenarioAccountingReconciled": abs(equity_reconciliation_delta) <= 0.01 and timeline_reconciled,
            "scenarioTimelineEquityMaxDeltaUsd": max_timeline_equity_delta,
            "scenarioTimelineFreeMarginMaxDeltaUsd": max_timeline_free_margin_delta,
            "scenarioTimelineAccountingReconciled": timeline_reconciled,
            "scenarioMetricsScope": "COUNTERFACTUAL_PORTFOLIO_INCLUDING_DCA_AND_OPTIONAL_STOP_OUT",
            "totalPositions": len(positions),
            "settledPositions": n_pos,
            "openAtEndPositions": len(open_end_positions),
            "baseTrades": sum(1 for p in settled_positions if p["layer"] == 0),
            "dcaLayers": sum(1 for p in settled_positions if p["layer"] > 0),
            "wins": len(wins),
            "breakevens": len(bes),
            "losses": len(losses),
            "winRatePct": round((len(wins) / n_pos) * 100.0, 2) if n_pos > 0 else 0.0,
            "breakevenRatePct": round((len(bes) / n_pos) * 100.0, 2) if n_pos > 0 else 0.0,
            "lossRatePct": round((len(losses) / n_pos) * 100.0, 2) if n_pos > 0 else 0.0,
            "profitFactor": pf,
            "expectancyR": exp_r,
            "realizedPnlUsd": round(balance - float(starting_balance), 2),
            "unrealizedPnlUsd": unrealized_end_usd,
            "netPnlUsd": round(balance - float(starting_balance), 2),
            "endingBalanceUsd": round(balance, 2),
            "endingEquityUsd": ending_equity_usd,
            "maxDrawdownUsd": max_bal_dd_usd,
            "maxDrawdownPct": round((max_bal_dd_usd / max(1.0, float(starting_balance))) * 100.0, 2),
            "maxEquityDrawdownUsd": max_eq_dd_usd,
            "maxEquityDrawdownPct": round((max_eq_dd_usd / max(1.0, float(starting_balance))) * 100.0, 2),
            "maxMarginUsageUsd": max_used_margin,
            "minFreeMarginUsd": min_free_margin,
            "minMarginLevelPct": min_margin_level_pct,
            "marginCallEvents": margin_call_count,
            "stopOutEvents": stop_out_count,
            "marginCallBreachedSnapshots": margin_call_breach_snapshots,
            "stopOutBreachedSnapshots": stop_out_breach_snapshots,
            "stopOutTriggerEvents": stop_out_trigger_events,
            "stopOutPriceUnverifiedSnapshots": stop_out_price_unverified_snapshots,
            "stopOutUnverifiedPotentialBreaches": stop_out_unverified_potential_breaches,
            "stopOutSimulationPriceCoverageComplete": (
                stop_out_price_unverified_snapshots == 0 if simulate_stop_out else None
            ),
            "riskExtremaIncludePreLiquidation": True,
            "maxConsecutiveLosses": max_streak,
            "dcaRejectedCounts": dca_rej_totals,
            "positions": positions,
            "timelineSnapshots": timeline_snapshots,
            "equityMarkingResolution": "CLOSED_M5" if last_mark_time is not None else "POSITION_EVENTS_PROXY",
            "m5FreshPriceCoveragePct": pricing_coverage,
            "m5StalePriceSnapshots": stale_m5_snapshots,
            "intrabarMarginRiskSnapshots": intrabar_stress_snapshots,
            "intrabarStopOutRiskSnapshots": intrabar_stopout_risk_snapshots,
            "intrabarMinMarginLevelPct": intrabar_min_margin_level_pct,
            "intrabarMarginRiskIsDiagnosticOnly": True,
            # OHLC extrema provide stress diagnostics, NOT broker liquidation.
            "intrabarMarginStressSimulated": False,
            "brokerStopOutExecutionVerified": False,
            "marginEventsAreObservationsOnly": not bool(simulate_stop_out),
            "stopOutLiquidationSimulated": bool(simulate_stop_out),
            "stopOutLiquidatedCount": sum(1 for p in positions if p.get("exitType") == "STOP_OUT_LIQUIDATED"),
            "stopOutLiquidationRule": str(liquidation_rule) if simulate_stop_out else None,
        }

    scen_a = _run_timeline(include_dca=False)
    scen_b = _run_timeline(include_dca=True)
    return {
        "withoutDcaNetPnlUsd": scen_a["netPnlUsd"],
        "withPositiveDcaNetPnlUsd": scen_b["netPnlUsd"],
        "netPnlDeltaUsd": round(scen_b["netPnlUsd"] - scen_a["netPnlUsd"], 2),
        "drawdownDeltaPct": round(scen_b["maxDrawdownPct"] - scen_a["maxDrawdownPct"], 2),
        "equityDrawdownDeltaPct": round(scen_b["maxEquityDrawdownPct"] - scen_a["maxEquityDrawdownPct"], 2),
        "totalSimulatedDcaLayers": scen_b["dcaLayers"],
        "dcaRejectedCounts": scen_b["dcaRejectedCounts"],
        "scenarioWithoutDca": scen_a,
        "scenarioWithPositiveDca": scen_b,
    }


def run_historical_backtest_on_mt5(mt5, active_symbol, cfg):
    """Bar-by-Bar Historical Backtest Engine with Out-of-Sample & Walk-Forward Validation (Section 4.1, 4.2, 4.3):
    - Uses exact same `evaluate_entry()` and `evaluate_position_management_step()` as live trading.
    - Synchronizes indicator history length (`CANDLE_LOOKBACK_BARS = 60`) with live trading.
    - Does NOT force-close positions after 96 M5 bars; positions run until SL/TP or end of dataset.
    - Separates `openPositionsAtEnd` (marked-to-market at final bar Bid/Ask) from settled `trades`.
    - Splits timeline into `IN_SAMPLE_DEV` (first 50%), `VALIDATION` (next 25%), and `OUT_OF_SAMPLE` (last 25%).
    - Computes 3-fold Walk-Forward summary.
    - Separates `winRatePct`, `breakevenRatePct`, and `lossRatePct` (never merges Wins + BE into Win Rate).
    - Labels DCA as `CHƯA ĐÁNH GIÁ DCA` (never fabricates DCA profit via multipliers).
    """
    cfg_b = cfg or {}
    # Do not treat truthy strings (e.g. "false") as verified permission to
    # simulate broker liquidation or silently switch liquidation ordering.
    simulate_stop_out = cfg_b.get("simulateStopOut", False)
    liquidation_rule = str(cfg_b.get("stopOutLiquidationRule") or "LARGEST_LOSS_FIRST").upper()
    if type(simulate_stop_out) is not bool or (
        simulate_stop_out and liquidation_rule not in ("FIFO", "LARGEST_LOSS_FIRST")
    ):
        return {
            "ok": False, "status": "INVALID_STOP_OUT_SIMULATION_CONFIG",
            "message": "Stop-out simulation requires a boolean flag and an explicit supported liquidation rule",
        }
    # Non-finite threshold values can silently disable every margin comparison.
    # Reject invalid broker-derived inputs before touching historical MT5 data.
    try:
        margin_call_level_pct = float(cfg_b.get("marginCallLevelPct", 100.0))
        stop_out_level_pct = float(cfg_b.get("stopOutLevelPct", 50.0))
        if not all(isfinite(v) and v > 0 for v in (margin_call_level_pct, stop_out_level_pct)):
            raise ValueError("Invalid margin threshold")
    except (TypeError, ValueError, OverflowError):
        return {
            "ok": False, "status": "INVALID_MARGIN_THRESHOLD_CONFIG",
            "message": "Backtest margin call and stop-out levels must be finite, positive numbers",
        }
    m5_all = cfg_b.get("m5Bars") or fetch_tf_candles(mt5, active_symbol, getattr(mt5, "TIMEFRAME_M5", 5), 9000)
    m15_all = cfg_b.get("m15Bars") or fetch_tf_candles(mt5, active_symbol, getattr(mt5, "TIMEFRAME_M15", 15), 3000)
    h1_all = cfg_b.get("h1Bars") or fetch_tf_candles(mt5, active_symbol, getattr(mt5, "TIMEFRAME_H1", 60), 800)
    h4_all = cfg_b.get("h4Bars") or fetch_tf_candles(mt5, active_symbol, getattr(mt5, "TIMEFRAME_H4", 240), 300)
    if min(len(m5_all), len(m15_all), len(h1_all), len(h4_all)) < 40:
        return {
            "ok": False,
            "status": "CHƯA CÓ DỮ LIỆU",
            "dcaEvaluationStatus": "DCA_NOT_EVALUATED",
            "message": "CHƯA CÓ DỮ LIỆU: Chưa đủ dữ liệu nến lịch sử từ MT5 để chạy Backtest trực tiếp.",
        }

    req_mode = str(cfg_b.get("strategyMode") or "AUTO_REGIME").upper()
    supported_modes = {
        "AUTO_REGIME", "SEMI_AUTO_TREND", "BOT_1_TREND", "BOT_2_SIDEWAY",
        "BOT_3_SWEEP", "BOT_4_SWEEP_DCA_PLUS", "LIQUIDITY_SWEEP_AND_TREND"
    }
    if req_mode not in supported_modes:
        return {
            "ok": False,
            "status": "PAUSE_OR_UNSUPPORTED",
            "strategyMode": req_mode,
            "trades": [],
            "openPositionsAtEnd": [],
            "dcaEvaluationStatus": "DCA_NOT_EVALUATED",
            "message": f"Chế độ '{req_mode}' đang PAUSE hoặc không hỗ trợ backtest.",
        }

    eval_mode = req_mode
    min_conf = float(cfg_b.get("minConfidence") or 85)
    spike_dist = max(5.0, min(20.0, float(cfg_b.get("m15SpikeTrailDist") or 10.0)))
    spread_pts = max(0.05, float(cfg_b.get("spreadPts") or 0.16))
    slippage_pts_round_trip = max(0.0, float(cfg_b.get("slippagePtsRoundTrip") if cfg_b.get("slippagePtsRoundTrip") is not None else 0.04))
    commission_pts_round_trip = max(0.0, float(cfg_b.get("commissionPtsRoundTrip") if cfg_b.get("commissionPtsRoundTrip") is not None else 0.04))
    cost_pts = max(
        0.0,
        float(
            cfg_b.get("roundTripCostPts")
            if cfg_b.get("roundTripCostPts") is not None
            else round(slippage_pts_round_trip + commission_pts_round_trip, 2)
        ),
    )
    swap_pts_per_day = float(cfg_b.get("swapPtsPerDay") or 0.0)
    be_at_one_r = bool(cfg_b.get("beAtOneR", True))
    enable_m5_trail = bool(cfg_b.get("enableM5StructuralTrail", True))
    enable_peak_lock = bool(cfg_b.get("enablePeakLock", True))
    base_lot = max(0.01, float(cfg_b.get("volume") or 0.02))
    starting_balance = max(100.0, float(cfg_b.get("startingBalance") or 4131.83))
    bt_sym_info = mt5.symbol_info(active_symbol) if callable(getattr(mt5, "symbol_info", None)) else None
    bt_acct_info = mt5.account_info() if callable(getattr(mt5, "account_info", None)) else None
    bt_leverage = int(getattr(bt_acct_info, "leverage", 0) or cfg_b.get("leverage") or 0)
    if cfg_b.get("usdPerPricePerLot") is not None:
        usd_per_price_per_lot = max(1.0, float(cfg_b["usdPerPricePerLot"]))
        contract_size_bt = float(getattr(bt_sym_info, "trade_contract_size", usd_per_price_per_lot) or usd_per_price_per_lot)
    elif bt_sym_info is not None and float(getattr(bt_sym_info, "trade_tick_size", 0) or 0) > 0 and float(getattr(bt_sym_info, "trade_tick_value", 0) or 0) > 0:
        usd_per_price_per_lot = float(bt_sym_info.trade_tick_value) / float(bt_sym_info.trade_tick_size)
        contract_size_bt = float(getattr(bt_sym_info, "trade_contract_size", usd_per_price_per_lot) or usd_per_price_per_lot)
    elif bt_sym_info is not None and float(getattr(bt_sym_info, "trade_contract_size", 0) or 0) > 0:
        usd_per_price_per_lot = float(bt_sym_info.trade_contract_size)
        contract_size_bt = usd_per_price_per_lot
    else:
        return {
            "ok": False,
            "status": "UNVERIFIED_BROKER_CONTRACT",
            "trades": [],
            "openPositionsAtEnd": [],
            "dcaEvaluationStatus": "DCA_NOT_EVALUATED",
            "message": "CHƯA XÁC MINH THÔNG SỐ HỢP ĐỒNG BROKER: Thiếu contract size / tick value từ MT5 — không suy đoán 100 USD/lot/giá.",
        }

    mode_label_map = {
        "AUTO_REGIME": "1. Tự Động Theo Trạng Thái Thị Trường (AUTO)",
        "SEMI_AUTO_TREND": "2. Bán Tự Động (Quản lý SL Cấu trúc)",
        "BOT_1_TREND": "3. Bot Thuận Xu Hướng & Quét Thanh Khoản",
        "BOT_2_SIDEWAY": "4. Bot Giao Dịch Biên Độ Ngang (Tắt DCA)",
        "BOT_3_SWEEP": "5. Bot Quét Thanh Khoản Đơn Lệnh",
        "BOT_4_SWEEP_DCA_PLUS": "6. Bot Quét Thanh Khoản + DCA Dương",
    }

    from bisect import bisect_right, bisect_left

    m5_close_times = [int(b[4]) + 300_000 for b in m5_all]
    m5_open_times = [int(b[4]) for b in m5_all]
    h1_close_times = [int(b[4]) + 3600_000 for b in h1_all]
    h4_close_times = [int(b[4]) + 14400_000 for b in h4_all]

    # Chronological boundaries for In-Sample (50%), Validation (25%), Out-of-Sample (25%)
    first_ts = int(m15_all[30][4]) + 900_000
    last_ts = int(m15_all[-1][4]) + 900_000
    span_ts = max(1, last_ts - first_ts)
    is_end_ts = first_ts + int(span_ts * 0.50)
    val_end_ts = first_ts + int(span_ts * 0.75)

    def _classify_period(ts_ms):
        if ts_ms <= is_end_ts:
            return "IN_SAMPLE_DEV"
        if ts_ms <= val_end_ts:
            return "VALIDATION"
        return "OUT_OF_SAMPLE"

    closed_trades_out = []
    open_positions_at_end = []
    wait_pullback_count = 0
    near_obstacle_blocked_count = 0
    ambiguous_bars_count = 0
    seq_num = 0
    idx = 30
    last_exit_ts = 0
    prior_regime = None
    bt_regime_state = {}
    bt_equity = float(starting_balance)
    max_daily_loss_pct = max(0.5, min(5.0, float(cfg_b.get("maxDailyLossPercent") or DEFAULT_MAX_DAILY_LOSS_PCT)))
    bt_daily_pnl = {}
    rejected_by_risk_gate = {"insufficientMargin": 0, "minLot": 0}
    risk_warning_events = {"perTradeRisk1Pct": 0, "portfolioRisk15Pct": 0, "dailyLoss3Pct": 0, "drawdown6Pct": 0}
    lookback_closed = CANDLE_LOOKBACK_BARS - 1  # 59 closed bars + 1 forming placeholder = 60 bars (identical to live)

    while idx < len(m15_all) - 1:
        cur_m15 = m15_all[idx]
        cur_open_ts = int(cur_m15[4])
        cur_close_ts = cur_open_ts + 15 * 60 * 1000

        if cur_open_ts < last_exit_ts:
            idx += 1
            continue

        m15_closed = m15_all[max(0, idx - (lookback_closed - 1)) : idx + 1]
        m5_end = bisect_right(m5_close_times, cur_close_ts)
        h1_end = bisect_right(h1_close_times, cur_close_ts)
        h4_end = bisect_right(h4_close_times, cur_close_ts)
        m5_closed = m5_all[max(0, m5_end - lookback_closed) : m5_end]
        h1_closed = h1_all[max(0, h1_end - lookback_closed) : h1_end]
        h4_closed = h4_all[max(0, h4_end - lookback_closed) : h4_end]
        if min(len(m5_closed), len(m15_closed), len(h1_closed), len(h4_closed)) < 26:
            idx += 1
            continue

        sub_m15 = m15_closed + [m15_closed[-1]]
        sub_m5 = m5_closed + [m5_closed[-1]]
        sub_h1 = h1_closed + [h1_closed[-1]]
        sub_h4 = h4_closed + [h4_closed[-1]]

        bid = float(cur_m15[3])
        ask = round(bid + spread_pts, 2)
        plan = evaluate_entry(
            sub_m5,
            sub_m15,
            sub_h1,
            sub_h4,
            bid,
            ask,
            eval_mode,
            min_conf,
            prior_regime=prior_regime,
            regime_state=bt_regime_state,
            round_trip_cost=cost_pts,
        )
        prior_regime = plan.get("marketRegime") or prior_regime

        if not plan.get("allowed"):
            if plan.get("status") == "WAIT_PULLBACK":
                wait_pullback_count += 1
            elif plan.get("subStatus") == "NEAR_OBSTACLE_INSUFFICIENT_RR":
                near_obstacle_blocked_count += 1
            idx += 1
            continue

        # Pass ALL remaining future bars up to dataset end (NO 96-bar arbitrary time close!)
        future_m15 = m15_all[idx + 1 :]
        f_m5_start = bisect_left(m5_open_times, cur_close_ts)
        future_m5 = m5_all[f_m5_start:]
        sim_bars = future_m5 if len(future_m5) >= 1 else future_m15
        if not sim_bars:
            idx += 1
            continue

        day_str = datetime.datetime.fromtimestamp(cur_close_ts / 1000.0, tz=datetime.timezone.utc).strftime("%Y-%m-%d")
        day_realized_loss = max(0.0, -float(bt_daily_pnl.get(day_str, 0.0)))
        sl_dist_bt = abs(float(plan.get("entry") or plan.get("entryPrice") or bid) - float(plan["sl"]))
        est_risk_usd = round(sl_dist_bt * base_lot * usd_per_price_per_lot, 2)
        if base_lot < 0.01:
            rejected_by_risk_gate["minLot"] += 1
            idx += 1
            continue
        # Section VIII: Fixed Lot backtest NEVER blocks entries on 1%/1.5%/3%/6% thresholds — record as warnings only!
        est_risk_pct = (est_risk_usd / max(1.0, bt_equity)) * 100.0
        if est_risk_pct > 1.0:
            risk_warning_events["perTradeRisk1Pct"] += 1
        if est_risk_pct > 1.5:
            risk_warning_events["portfolioRisk15Pct"] += 1
        if (day_realized_loss + est_risk_usd) > bt_equity * (max_daily_loss_pct / 100.0):
            risk_warning_events["dailyLoss3Pct"] += 1
        if starting_balance > 0 and ((starting_balance - bt_equity) / starting_balance) * 100.0 > 6.0:
            risk_warning_events["drawdown6Pct"] += 1
        entry_px_bt = float(plan.get("entry") or plan.get("entryPrice") or bid)
        bt_order_type = 0 if plan["side"] == "BUY" else 1
        needed_margin_bt = None
        calc_margin_fn = getattr(mt5, "order_calc_margin", None)
        if callable(calc_margin_fn):
            try:
                m_val = calc_margin_fn(bt_order_type, active_symbol, base_lot, entry_px_bt)
                if m_val is not None and isfinite(float(m_val)) and float(m_val) > 0:
                    needed_margin_bt = float(m_val)
            except Exception:
                needed_margin_bt = None
        if needed_margin_bt is None and bt_leverage > 0:
            needed_margin_bt = (contract_size_bt * base_lot * entry_px_bt) / float(bt_leverage)
        if needed_margin_bt is None:
            return {
                "ok": False,
                "status": "UNVERIFIED_BROKER_MARGIN",
                "trades": [],
                "openPositionsAtEnd": [],
                "dcaEvaluationStatus": "DCA_NOT_EVALUATED",
                "message": "CHƯA XÁC MINH KÝ QUỸ BROKER: Thiếu order_calc_margin và leverage tài khoản từ MT5.",
            }
        if bt_equity < needed_margin_bt:
            rejected_by_risk_gate["insufficientMargin"] += 1
            idx += 1
            continue

        sim = simulate_position_lifecycle(
            plan,
            sim_bars,
            future_m15_bars=future_m15,
            prior_m5_bars=m5_closed[-10:],
            cfg={
                "m15SpikeTrailDist": spike_dist,
                "roundTripCostPts": cost_pts,
                "askSpreadPts": spread_pts if plan["side"] == "SELL" else 0.0,
                "swapPtsPerDay": swap_pts_per_day,
                "beAtOneR": be_at_one_r,
                "enableM5StructuralTrail": enable_m5_trail,
                "enablePeakLock": enable_peak_lock,
            },
        )
        if sim["ambiguousBar"]:
            ambiguous_bars_count += 1

        side = plan["side"]
        setup_score = int(plan.get("setupScore") or plan.get("confidence") or 88)
        strat_used = str(plan.get("strategyMode") or eval_mode)
        init_r = float(plan["initialR"])
        pts_net = sim["pts"]
        exit_type = sim["exitType"]
        period_tag = _classify_period(cur_close_ts)

        if exit_type == "AMBIGUOUS_BAR_SL":
            reason = f"⚠️ [NẾN CHẠM CẢ SL & TP - QUY TẮC BẢO THỦ] Tính chạm SL ({sim['exit']:.2f}, {pts_net:+.2f} giá)"
        elif exit_type == "SL_HIT":
            reason = f"❌ [CHẠM SL CẤU TRÚC] Chạm SL ban đầu ({sim['exit']:.2f}, {pts_net:+.2f} giá)"
        elif exit_type == "SL_HIT_REDUCED":
            reason = f"🛡 [CHẠM SL ĐÃ NÂNG TRƯỚC BE] Đã nâng SL theo cấu trúc M5 trước BE giúp giảm lỗ ({sim['exit']:.2f}, {pts_net:+.2f} giá)"
        elif exit_type == "BE_SAVED":
            reason = f"🛡 [BẢO VỆ HÒA VỐN 1R] Đạt 1R (+{init_r:.2f} giá) → Thoát tại BE ({sim['exit']:.2f}, {pts_net:+.2f} giá)"
        elif exit_type in ("TP_HIT", "SIDEWAY_TP"):
            reason = f"🎯 [CHẠM TAKE PROFIT] Đạt mục tiêu TP ({sim['exit']:.2f}, {pts_net:+.2f} giá, cực trị +{sim['peakPts']:.2f} giá)"
        elif exit_type == "TREND_TRAIL_EXIT":
            reason = f"🔥 [KHÓA LỢI NHUẬN TRAILING M5 / CỰC TRỊ 10 GIÁ] Cực trị +{sim['peakPts']:.2f} giá → Thoát tại SL nâng ({sim['exit']:.2f}, {pts_net:+.2f} giá)"
        else:
            reason = f"⏳ [VỊ THẾ CHƯA ĐÓNG CUỐI TẬP DỮ LIỆU] Định giá Mark-to-Market tại {sim['exit']:.2f} ({pts_net:+.2f} giá)"

        dt_str = datetime.datetime.fromtimestamp(cur_close_ts / 1000.0, tz=datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        session_name = _classify_session_utc(cur_close_ts)
        seq_num += 1
        trade_record = {
            "id": f"MT5-{seq_num:03d}",
            "dt": dt_str,
            "tsMs": cur_close_ts,
            "exitTsMs": int(sim["exitTs"]),
            "period": period_tag,
            "session": session_name,
            "marketRegime": plan.get("marketRegime", "UNKNOWN"),
            "requestedMode": eval_mode,
            "modeKey": strat_used,
            "ruleMode": strat_used,
            "modeLabel": mode_label_map.get(strat_used, f"MT5 ({strat_used})"),
            "side": side,
            "setupScore": setup_score,
            "confidence": setup_score,
            "scoreType": "HEURISTIC_POINTS_OUT_OF_100",
            "dcaRatio": 0.0,
            "dcaLayersSimulated": [],
            "dcaPnlUsd": 0.0,
            "dcaStatus": "DCA_NOT_EVALUATED",
            "entry": sim["entry"],
            "sl": sim["initialSl"],
            "finalSl": sim["finalSl"],
            "tp": sim["tp"],
            "tpSource": plan.get("tpSource", "CONFIRMED_H1_H4_OBSTACLE"),
            "initialR": init_r,
            "be": round(sim["entry"] + init_r if side == "BUY" else sim["entry"] - init_r, 2),
            "exit": sim["exit"],
            "exitType": exit_type,
            "isOpenAtEnd": sim["isOpenAtEnd"],
            "ambiguousBar": sim["ambiguousBar"],
            "preBeTrailed": sim["preBeTrailed"],
            "rawPts": sim["rawPts"],
            "costPts": sim["costPts"],
            "pts": pts_net,
            "rMultiple": sim["rMultiple"],
            "peakPts": sim["peakPts"],
            "reason": reason,
        }

        trade_record["ticket"] = 10000 + seq_num
        trade_record["layer"] = 0
        trade_record["volume"] = base_lot
        trade_record["marginUsd"] = round(needed_margin_bt, 2)
        trade_record["beReachedTs"] = int(sim.get("beReachedTs") or 0)
        trade_record["oneRReachedTs"] = int(sim.get("oneRReachedTs") or 0)
        trade_record["slHistory"] = sim.get("slHistory", [sim["initialSl"], sim["finalSl"]])

        # Real Positive DCA simulation (Section II & III):
        # - Zero look-ahead: ONLY evaluates bars AFTER `beReachedTs > 0` (when SL was actually moved to BE on timeline).
        # - Structural M5 SL 6.0-8.0 USD/oz required (if >8.0 or invalid -> WAIT_PULLBACK; NEVER hardcodes 6.8!).
        # - Checks H1/H4 near obstacles & net R:R >= 1.6 after spread/commission/slippage for both BUY and SELL.
        # - Checks simultaneous portfolio Used Margin & Free Margin across base + all currently open DCA layers.
        enable_bt_dca = bool(cfg_b.get("enablePositiveDca", False)) and strat_used != "BOT_2_SIDEWAY"
        bt_dca_lot = None
        if enable_bt_dca:
            if cfg_b.get("fixedDcaLot") is not None and float(cfg_b.get("fixedDcaLot") or 0) > 0:
                bt_dca_lot = float(cfg_b["fixedDcaLot"])
            elif cfg_b.get("dcaUseBaseLot") is True:
                bt_dca_lot = base_lot
        be_reached_ts = int(sim.get("beReachedTs") or 0)
        dca_rej = trade_record.setdefault(
            "dcaRejectedCounts",
            {
                "waitPullback": 0,
                "insufficientRrOrNearObstacle": 0,
                "insufficientMargin": 0,
                "beforeBe": 0,
                "priorLayerNotAtBe": 0,
                "noM15SignalOrConflict": 0,
            },
        )
        dca_layers_out = []
        if enable_bt_dca and bt_dca_lot and be_reached_ts > 0:
            max_dca_layers_bt = max(1, min(3, int(cfg_b.get("maxDcaLayers") or 2)))
            dca_step_bt = max(1.2, float(cfg_b.get("dcaStepDistance") or 3.5))
            last_dca_entry = float(sim["entry"])
            last_dca_m15_close_ts = int(cur_close_ts)
            dca_pnl_sum_usd = 0.0
            dca_regime_state = dict(bt_regime_state)
            dca_prior_regime = prior_regime
            point_bt = float(getattr(bt_sym_info, "point", 0.01) or 0.01) if bt_sym_info else 0.01
            stops_gap_bt = max(
                point_bt,
                float(getattr(bt_sym_info, "trade_stops_level", 0) or 0) * point_bt if bt_sym_info else 0.0,
                float(getattr(bt_sym_info, "trade_freeze_level", 0) or 0) * point_bt if bt_sym_info else 0.0,
            )
            for fb_i, fb_bar in enumerate(sim_bars):
                fb_open_ts = int(fb_bar[4])
                fb_close_ts = fb_open_ts + 300_000
                if fb_close_ts >= int(sim["exitTs"]):
                    break
                if fb_close_ts <= be_reached_ts:
                    dca_rej["beforeBe"] += 1
                    continue
                open_dca_now = [l for l in dca_layers_out if int(l["exitTs"]) > fb_close_ts]
                if len(dca_layers_out) >= max_dca_layers_bt:
                    break
                # Task 2.11 & Task 4.8: Every currently open prior DCA layer must also have reached BE before adding another layer!
                if any(int(ol.get("beReachedTs") or 0) <= 0 or fb_close_ts <= int(ol["beReachedTs"]) for ol in open_dca_now):
                    dca_rej["priorLayerNotAtBe"] += 1
                    continue

                bid_b = float(fb_bar[3])
                ask_b = round(bid_b + spread_pts, 2)
                cur_px_b = ask_b if side == "BUY" else bid_b
                fav_move = (cur_px_b - last_dca_entry) if side == "BUY" else (last_dca_entry - cur_px_b)
                if fav_move < dca_step_bt:
                    continue

                # Slice ONLY closed candles up to fb_close_ts (strictly no future candles!)
                m5_dca_idx = bisect_right(m5_close_times, fb_close_ts)
                h1_dca_idx = bisect_right(h1_close_times, fb_close_ts)
                h4_dca_idx = bisect_right(h4_close_times, fb_close_ts)
                m5_dca_closed = m5_all[max(0, m5_dca_idx - lookback_closed) : m5_dca_idx]
                m15_dca_closed = [b for b in m15_all if int(b[4]) + 900_000 <= fb_close_ts][-lookback_closed:]
                h1_dca_closed = h1_all[max(0, h1_dca_idx - lookback_closed) : h1_dca_idx]
                h4_dca_closed = h4_all[max(0, h4_dca_idx - lookback_closed) : h4_dca_idx]
                if min(len(m5_dca_closed), len(m15_dca_closed), len(h1_dca_closed), len(h4_dca_closed)) < 10:
                    continue

                # Evaluate closed M15 signal at fb_close_ts using the exact same evaluate_entry as live
                cur_m15_dca_close_ts = int(m15_dca_closed[-1][4]) + 900_000
                dca_sig = evaluate_entry(
                    m5_dca_closed + [m5_dca_closed[-1]],
                    m15_dca_closed + [m15_dca_closed[-1]],
                    h1_dca_closed + [h1_dca_closed[-1]],
                    h4_dca_closed + [h4_dca_closed[-1]],
                    bid_b,
                    ask_b,
                    eval_mode,
                    min_conf,
                    prior_regime=dca_prior_regime,
                    regime_state=dca_regime_state,
                    round_trip_cost=cost_pts,
                )
                dca_sig["closedM15Time"] = cur_m15_dca_close_ts
                dca_prior_regime = dca_sig.get("marketRegime") or dca_prior_regime

                # Structural M5/M15 SL at cur_px_b in [6.0, 8.0] USD/oz (never hardcode 6.8!)
                dca_sl_cand = structural_stop(
                    side,
                    cur_px_b,
                    m5_dca_closed + [m5_dca_closed[-1]],
                    m15_dca_closed + [m15_dca_closed[-1]],
                    max_distance=MAX_STRUCTURAL_SL_DIST,
                )

                # Call unified decision function shared between Live and Backtest
                dec_bt = evaluate_positive_dca_decision(
                    side=side,
                    exec_price=cur_px_b,
                    last_entry_price=last_dca_entry,
                    base_tp=float(sim["tp"]),
                    current_dca_layers=len(dca_layers_out),
                    max_layers=max_dca_layers_bt,
                    step_distance=dca_step_bt,
                    strategy_mode=eval_mode,
                    signal=dca_sig,
                    last_signal_m15_ts=last_dca_m15_close_ts,
                    candidate_sl=dca_sl_cand,
                    h1_closed=h1_dca_closed,
                    h4_closed=h4_dca_closed,
                    min_conf=min_conf,
                    min_rr=1.6,
                    round_trip_cost=cost_pts,
                    stops_gap=stops_gap_bt,
                    bid_price=bid_b,
                    ask_price=ask_b,
                )
                if not dec_bt["ok"]:
                    rc_code = dec_bt["reasonCode"]
                    if rc_code == "WAIT_PULLBACK":
                        dca_rej["waitPullback"] += 1
                    elif rc_code == "NEAR_OBSTACLE_OR_LOW_RR":
                        dca_rej["insufficientRrOrNearObstacle"] += 1
                    elif rc_code in ("NO_M15_SIGNAL", "REGIME_OR_SIGNAL_CONFLICT", "DUPLICATE_OR_STALE_M15_SIGNAL"):
                        dca_rej["noM15SignalOrConflict"] += 1
                    continue

                dca_sl = dec_bt["dcaSl"]
                dca_tp = dec_bt["dcaTp"]
                dca_initial_r = dec_bt["initialR"]
                net_rr_dca = dec_bt["netRr"]

                # Check simultaneous portfolio Used Margin & Free Margin across base + all open DCA layers at fb_open_ts
                dca_margin = None
                if callable(calc_margin_fn):
                    try:
                        m_dca = calc_margin_fn(bt_order_type, active_symbol, bt_dca_lot, cur_px_b)
                        if m_dca is not None and isfinite(float(m_dca)) and float(m_dca) > 0:
                            dca_margin = float(m_dca)
                    except Exception:
                        dca_margin = None
                if dca_margin is None:
                    dca_margin = (contract_size_bt * bt_dca_lot * cur_px_b) / float(bt_leverage) if bt_leverage > 0 else (needed_margin_bt * (bt_dca_lot / base_lot))

                closed_dca_pnl_now = sum(float(l["netPnlUsd"]) for l in dca_layers_out if int(l["exitTs"]) <= fb_close_ts and not l.get("isOpenAtEnd", False))
                used_margin_now = needed_margin_bt + sum(float(l["marginUsd"]) for l in open_dca_now)
                base_float_pts = (bid_b - float(sim["entry"])) if side == "BUY" else (float(sim["entry"]) - ask_b)
                floating_usd_now = base_float_pts * base_lot * usd_per_price_per_lot
                for ol in open_dca_now:
                    ol_pts = (bid_b - float(ol["entryPrice"])) if side == "BUY" else (float(ol["entryPrice"]) - ask_b)
                    floating_usd_now += ol_pts * float(ol["fixedDcaLot"]) * usd_per_price_per_lot
                equity_now = bt_equity + closed_dca_pnl_now + floating_usd_now
                free_margin_now = equity_now - used_margin_now
                if dca_margin > free_margin_now * 0.95:
                    dca_rej["insufficientMargin"] += 1
                    continue

                dca_plan = {
                    "side": side,
                    "entry": cur_px_b,
                    "entryReference": cur_px_b,
                    "sl": dca_sl,
                    "tp": dca_tp,
                    "initialR": dca_initial_r,
                    "strategyMode": strat_used,
                    "setupScore": setup_score,
                    "closedM15Time": fb_close_ts,
                }
                dca_sim = simulate_position_lifecycle(
                    dca_plan,
                    sim_bars[fb_i + 1:],
                    future_m15_bars=future_m15,
                    prior_m5_bars=m5_dca_closed[-10:],
                    cfg={
                        "m15SpikeTrailDist": spike_dist,
                        "roundTripCostPts": cost_pts,
                        "askSpreadPts": spread_pts if side == "SELL" else 0.0,
                        "swapPtsPerDay": swap_pts_per_day,
                        "beAtOneR": be_at_one_r,
                        "enableM5StructuralTrail": enable_m5_trail,
                        "enablePeakLock": enable_peak_lock,
                    },
                )
                if not dca_sim.get("ok", True):
                    continue
                dca_net_pts = float(dca_sim["netPts"])
                dca_net_usd = round(dca_net_pts * bt_dca_lot * usd_per_price_per_lot, 2)
                if not dca_sim.get("isOpenAtEnd", False):
                    dca_pnl_sum_usd = round(dca_pnl_sum_usd + dca_net_usd, 2)
                layer_idx = len(dca_layers_out) + 1
                dca_layers_out.append({
                    "ticket": (10000 + seq_num) * 100 + layer_idx,
                    "layer": layer_idx,
                    "side": side,
                    "triggerCondition": f"Base at BE ({be_reached_ts}) & M15 ({cur_m15_dca_close_ts}) & +{fav_move:.2f} >= +{dca_step_bt:.2f} & M5 SL {dca_initial_r:.2f}",
                    "closedM15Time": cur_m15_dca_close_ts,
                    "entryTs": fb_close_ts,
                    "decisionM5OpenTs": fb_open_ts,
                    "decisionM5CloseTs": fb_close_ts,
                    "entryPrice": round(cur_px_b, 2),
                    "fixedDcaLot": bt_dca_lot,
                    "initialSl": dca_sim["initialSl"],
                    "initialR": dca_initial_r,
                    "finalSl": dca_sim["finalSl"],
                    "sl": dca_sl,
                    "tp": dca_tp,
                    "netRewardRiskAtEntry": net_rr_dca,
                    "beReachedTs": int(dca_sim.get("beReachedTs") or 0),
                    "slHistory": dca_sim.get("slHistory", [dca_sl, dca_sim["finalSl"]]),
                    "spreadPts": spread_pts,
                    "commissionPts": commission_pts_round_trip,
                    "slippagePts": slippage_pts_round_trip,
                    "swapPts": dca_sim.get("swapPts", 0.0),
                    "costPts": dca_sim["costPts"],
                    "marginUsd": round(dca_margin, 2),
                    "exitTs": int(dca_sim["exitTs"]),
                    "exitPrice": dca_sim["exit"],
                    "exitType": dca_sim["exitType"],
                    "isOpenAtEnd": bool(dca_sim.get("isOpenAtEnd", False)),
                    "pts": dca_net_pts,
                    "netPts": dca_net_pts,
                    "rMultiple": dca_sim["rMultiple"],
                    "realizedPnlUsd": 0.0 if dca_sim.get("isOpenAtEnd", False) else dca_net_usd,
                    "unrealizedPnlUsd": dca_net_usd if dca_sim.get("isOpenAtEnd", False) else 0.0,
                    "netPnlUsd": dca_net_usd,
                    "reconciledSimulated": True,
                })
                last_dca_entry = cur_px_b
                last_dca_m15_close_ts = cur_m15_dca_close_ts
            if dca_layers_out:
                trade_record["dcaLayersSimulated"] = dca_layers_out
                trade_record["dcaPnlUsd"] = dca_pnl_sum_usd
                trade_record["dcaStatus"] = "DCA_SIMULATED_WITH_FIXED_LOT"

        if sim["isOpenAtEnd"]:
            open_positions_at_end.append(trade_record)
            break
        else:
            closed_trades_out.append(trade_record)
            pnl_usd_bt = round(float(pts_net) * base_lot * usd_per_price_per_lot, 2)
            bt_equity = round(bt_equity + pnl_usd_bt, 2)
            exit_day_str = datetime.datetime.fromtimestamp(int(sim["exitTs"]) / 1000.0, tz=datetime.timezone.utc).strftime("%Y-%m-%d")
            bt_daily_pnl[exit_day_str] = round(bt_daily_pnl.get(exit_day_str, 0.0) + pnl_usd_bt, 2)
            max_pos_exit_ts = max([int(sim["exitTs"])] + [int(l["exitTs"]) for l in dca_layers_out])
            last_exit_ts = max(cur_close_ts + 900_000, max_pos_exit_ts)
        idx += 1

    full_metrics = _compute_metrics_for_trade_slice(closed_trades_out, open_positions_at_end, base_lot, starting_balance, usd_per_price_per_lot)
    by_period = {
        "IN_SAMPLE_DEV": _compute_metrics_for_trade_slice(
            [t for t in closed_trades_out if t["period"] == "IN_SAMPLE_DEV"], [], base_lot, starting_balance, usd_per_price_per_lot
        ),
        "VALIDATION": _compute_metrics_for_trade_slice(
            [t for t in closed_trades_out if t["period"] == "VALIDATION"], [], base_lot, starting_balance, usd_per_price_per_lot
        ),
        "OUT_OF_SAMPLE": _compute_metrics_for_trade_slice(
            [t for t in closed_trades_out if t["period"] == "OUT_OF_SAMPLE"], open_positions_at_end, base_lot, starting_balance, usd_per_price_per_lot
        ),
        "FULL_DATASET": full_metrics,
    }

    by_strategy_group = {
        "BOT_1_TREND": _compute_metrics_for_trade_slice(
            [t for t in closed_trades_out if t["ruleMode"] == "BOT_1_TREND"], [], base_lot, starting_balance, usd_per_price_per_lot
        ),
        "BOT_2_SIDEWAY": _compute_metrics_for_trade_slice(
            [t for t in closed_trades_out if t["ruleMode"] == "BOT_2_SIDEWAY"], [], base_lot, starting_balance, usd_per_price_per_lot
        ),
        "BOT_3_SWEEP": _compute_metrics_for_trade_slice(
            [t for t in closed_trades_out if t["ruleMode"] in ("BOT_3_SWEEP", "BOT_4_SWEEP_DCA_PLUS")], [], base_lot, starting_balance, usd_per_price_per_lot
        ),
        "AUTO_REGIME": full_metrics,
    }

    chronological_segments = []
    for seg_idx in range(3):
        f_start = first_ts + int(span_ts * (seg_idx / 3.0))
        f_end = first_ts + int(span_ts * ((seg_idx + 1) / 3.0))
        seg_trades = [t for t in closed_trades_out if f_start <= int(t["tsMs"]) <= f_end]
        chronological_segments.append({
            "segment": seg_idx + 1,
            "label": f"Giai đoạn {seg_idx + 1}/3 (Thống kê theo thời gian, không phải Walk-Forward Optimization)",
            "startUtc": datetime.datetime.fromtimestamp(f_start / 1000.0, tz=datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
            "endUtc": datetime.datetime.fromtimestamp(f_end / 1000.0, tz=datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
            "metrics": _compute_metrics_for_trade_slice(seg_trades, [], base_lot, starting_balance, usd_per_price_per_lot),
        })

    metadata = {
        "dataSource": "CUSTOM_OHLC_BARS" if cfg_b.get("m15Bars") else "MT5_TERMINAL_COPY_RATES",
        "broker": str(cfg_b.get("server") or "DBGMarkets-Live"),
        "symbol": active_symbol,
        "timeRangeUtc": {
            "start": datetime.datetime.fromtimestamp(first_ts / 1000.0, tz=datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
            "end": datetime.datetime.fromtimestamp(last_ts / 1000.0, tz=datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        },
        "candleLookbackBars": CANDLE_LOOKBACK_BARS,
        "codeVersion": "V6-AUDIT-REMEDIATION",
        "configUsed": {
            "strategyMode": eval_mode,
            "minSetupScore": min_conf,
            "beAtOneR": be_at_one_r,
            "enableM5StructuralTrail": enable_m5_trail,
            "enablePeakLock": enable_peak_lock,
            "m15SpikeTrailDist": spike_dist,
        },
        "costAssumptions": {
            "spreadPts": spread_pts,
            "slippagePtsRoundTrip": slippage_pts_round_trip,
            "commissionPtsRoundTrip": commission_pts_round_trip,
            "roundTripCostPts": cost_pts,
            "swapPtsPerDay": swap_pts_per_day,
        },
        "openPositionValuationMethod": "MARK_TO_MARKET_AT_FINAL_BAR_BID_ASK_SEPARATED_FROM_CLOSED_TRADES",
        "dcaEvaluationStatus": "DCA_NOT_EVALUATED",
    }

    return {
        "ok": True,
        "isSimulatedSampleData": False,
        "symbol": active_symbol,
        "requestedMode": eval_mode,
        "dcaEvaluationStatus": ("DCA_SIMULATED_WITH_FIXED_LOT" if bool(cfg_b.get("enablePositiveDca", False)) else "DCA_NOT_EVALUATED"),
        "dcaComparison": {
            **_build_portfolio_scenario_comparison(
                closed_trades_out, open_positions_at_end, base_lot, starting_balance,
                usd_per_price_per_lot,
                margin_call_level_pct=margin_call_level_pct,
                stop_out_level_pct=stop_out_level_pct,
                market_m5_bars=m5_all,
                market_spread_pts=spread_pts,
                simulate_stop_out=simulate_stop_out,
                liquidation_rule=liquidation_rule,
            ),
            "status": ("DCA_SIMULATED_WITH_FIXED_LOT" if bool(cfg_b.get("enablePositiveDca", False)) else "DCA_NOT_EVALUATED"),
        },
        "barsScanned": {"m5": len(m5_all), "m15": len(m15_all), "h1": len(h1_all), "h4": len(h4_all)},
        # Top-level trade statistics exclude counterfactual DCA/stop-out events.
        # The scenario results under dcaComparison carry their own wins/losses,
        # realized P/L and accounting reconciliation.
        "tradeSummaryScope": "BASE_STRATEGY_TRADES_EXCLUDES_DCA_AND_SIMULATED_STOP_OUT",
        "stopOutScenarioMetricsLocation": "dcaComparison.scenarioWithPositiveDca",
        "tradeCount": full_metrics["closedTradeCount"],
        "openAtEndCount": len(open_positions_at_end),
        "wins": full_metrics["wins"],
        "breakevens": full_metrics["breakevens"],
        "losses": full_metrics["losses"],
        "winRatePct": full_metrics["winRatePct"],
        "breakevenRatePct": full_metrics["breakevenRatePct"],
        "lossRatePct": full_metrics["lossRatePct"],
        "waitPullbackSkipped": wait_pullback_count,
        "nearObstacleBlocked": near_obstacle_blocked_count,
        "ambiguousBarsCount": ambiguous_bars_count,
        "profitFactor": full_metrics["profitFactor"],
        "expectancyR": full_metrics["expectancyR"],
        "netPts": full_metrics["netPts"],
        "netPnlUsd": full_metrics["netPnlUsd"],
        "maxDrawdownPts": full_metrics["maxDrawdownPts"],
        "maxDrawdownPct": full_metrics["maxDrawdownPct"],
        "maxConsecutiveLosses": full_metrics["maxConsecutiveLosses"],
        "byPeriod": by_period,
        "byStrategyGroup": by_strategy_group,
        "chronologicalSegments": chronological_segments,
        "simulationResolution": "OHLC_M5",
        "simulationLimitations": "Mô phỏng trên nến OHLC M5 (không có dữ liệu tick nội nến; trailing chỉ đánh giá khi đóng nến M5; không khẳng định giống live 100%).",
        "sizingMode": "FIXED_LOT",
        "fixedLot": base_lot,
        "riskWarningEvents": risk_warning_events,
        "rejectedByRiskGate": rejected_by_risk_gate,
        "runId": f"bt_{uuid.uuid4().hex[:10]}",
        "metadata": metadata,
        "trades": closed_trades_out,
        "openPositionsAtEnd": open_positions_at_end,
        "message": (
            f"Backtest đồng nhất chạy thật ({eval_mode} trên {active_symbol}): "
            f"{full_metrics['closedTradeCount']} lệnh đã tất toán "
            f"({full_metrics['wins']} Thắng [{full_metrics['winRatePct']}%] · "
            f"{full_metrics['breakevens']} Hòa BE [{full_metrics['breakevenRatePct']}%] · "
            f"{full_metrics['losses']} Thua [{full_metrics['lossRatePct']}%] · "
            f"Đang mở cuối kỳ: {len(open_positions_at_end)} lệnh · "
            f"PF {full_metrics['profitFactor']} · Expectancy {full_metrics['expectancyR']:+.3f}R · "
            f"Lãi ròng sau phí {full_metrics['netPts']:+.2f} giá · Chuỗi thua dài nhất {full_metrics['maxConsecutiveLosses']} · "
            f"DCA: CHƯA ĐÁNH GIÁ DCA)."
        ),
    }


def main():
    raw_cfg = sys.stdin.read() if (len(sys.argv) > 1 and sys.argv[1] == "--stdin") else (sys.argv[1] if len(sys.argv) > 1 else "{}")
    try:
        cfg = json.loads(raw_cfg)
    except Exception:
        cfg = {}

    action = str(cfg.get("action") or "probe").lower()
    mt5, pkg_err = ensure_mt5_installed()
    if mt5 is None:
        sys.stdout.write(json.dumps({
            "connected": False,
            "errorCode": "MT5_PYTHON_PACKAGE_MISSING",
            "errorMessage": pkg_err,
            "diagnostics": {
                "step1_api": "PASS",
                "step2_python_mt5": "FAIL",
                "step3_terminal_login": "WAIT",
                "step4_symbol_quote": "WAIT",
                "step5_algo_trading": "WAIT",
            },
            "timestamp": int(time.time() * 1000),
        }, ensure_ascii=False) + "\n")
        return

    ok_conn, conn_err = connect_mt5(mt5, cfg)
    if not ok_conn:
        sys.stdout.write(json.dumps({
            "connected": False,
            "errorCode": "MT5_TERMINAL_OR_LOGIN_FAILED",
            "errorMessage": conn_err,
            "diagnostics": {
                "step1_api": "PASS",
                "step2_python_mt5": "PASS",
                "step3_terminal_login": "FAIL",
                "step4_symbol_quote": "WAIT",
                "step5_algo_trading": "WAIT",
            },
            "timestamp": int(time.time() * 1000),
        }, ensure_ascii=False) + "\n")
        return

    account = mt5.account_info()
    terminal = mt5.terminal_info()
    if account is None or terminal is None:
        mt5.shutdown()
        sys.stdout.write(json.dumps({
            "connected": False,
            "errorCode": "MT5_ACCOUNT_NONE",
            "errorMessage": "Phần mềm MT5 đang mở nhưng chưa đăng nhập tài khoản.",
            "timestamp": int(time.time() * 1000),
        }, ensure_ascii=False) + "\n")
        return

    preferred_symbol = str(cfg.get("brokerSymbol") or "XAUUSD.G").strip()
    active_symbol, available_gold_symbols = resolve_gold_symbol(mt5, preferred_symbol)

    candles_m5 = fetch_tf_candles(mt5, active_symbol, mt5.TIMEFRAME_M5, CANDLE_LOOKBACK_BARS)
    candles = fetch_tf_candles(mt5, active_symbol, mt5.TIMEFRAME_M15, CANDLE_LOOKBACK_BARS)
    candles_h1 = fetch_tf_candles(mt5, active_symbol, mt5.TIMEFRAME_H1, CANDLE_LOOKBACK_BARS)
    candles_h4 = fetch_tf_candles(mt5, active_symbol, mt5.TIMEFRAME_H4, CANDLE_LOOKBACK_BARS)

    live_analysis = analyze_live_candles(candles, candles_h1, candles_h4)
    tick_for_signal = mt5.symbol_info_tick(active_symbol)
    signal_bid = float(getattr(tick_for_signal, "bid", 0.0) or 0.0)
    signal_ask = float(getattr(tick_for_signal, "ask", 0.0) or 0.0)
    signal_mode = str(cfg.get("strategyMode") or "PAUSE")

    fresh_sig_ok, sig_age, fresh_sig_err = verify_tick_freshness_utc(
        tick_for_signal, max_age_sec=float(cfg.get("maxQuoteAgeSeconds") or DEFAULT_MAX_QUOTE_AGE_SEC)
    )
    live_acc_login = int(getattr(account, "login", 0) or cfg.get("login") or 0)
    live_acc_server = str(getattr(account, "server", "") or cfg.get("server") or "DEFAULT").strip()
    regime_key = f"{live_acc_login}|{live_acc_server}|{active_symbol}|V6"
    all_regime_states = _load_json_state(REGIME_STATE_FILE)
    live_regime_state = dict(all_regime_states.get(regime_key) or {})
    prev_closed_ts = int(live_regime_state.get("lastClosedM15Ts") or 0)

    entry_signal = evaluate_entry(
        candles_m5, candles, candles_h1, candles_h4, signal_bid, signal_ask,
        signal_mode, cfg.get("minConfidence", 85),
        prior_regime=live_regime_state.get("regime"),
        regime_state=live_regime_state,
    )
    entry_signal["requestedMode"] = signal_mode
    if int(live_regime_state.get("lastClosedM15Ts") or 0) != prev_closed_ts:
        def _save_regime(rs):
            rs[regime_key] = live_regime_state
            return rs
        _update_json_state(REGIME_STATE_FILE, _save_regime)
    if not fresh_sig_ok and entry_signal.get("allowed"):
        entry_signal["allowed"] = False
        entry_signal["status"] = "STALE_QUOTE"
        entry_signal["reason"] = fresh_sig_err

    active_dir = entry_signal.get("side") if entry_signal.get("side") in ("BUY", "SELL") else entry_signal.get("preferredSide")
    if active_dir in ("BUY", "SELL", "NEUTRAL"):
        live_analysis["preferredSide"] = active_dir
        live_analysis["signalSide"] = active_dir
        live_analysis["marketRegime"] = entry_signal.get("marketRegime", "UNKNOWN")
        if entry_signal.get("allowed"):
            score_val = int(entry_signal.get("setupScore") or entry_signal.get("confidence") or 88)
            live_analysis["setupScore"] = score_val
            live_analysis["confidence"] = score_val
            live_analysis["reason"] = (
                f"Đã xác nhận tín hiệu {active_dir} ({entry_signal.get('patternName')}) · "
                f"SL cấu trúc: {entry_signal.get('sl')} · TP: {entry_signal.get('tp')} [{entry_signal.get('tpReason')}] "
                f"(R:R ròng = 1:{entry_signal.get('netRewardRisk')}, điểm setup {score_val}/100)."
            )
        else:
            live_analysis["waitReasonVi"] = entry_signal.get("waitReasonVi", "")

    raw_positions, positions_read_ok, positions_read_err = _safe_read_positions(mt5)
    dca_settings = dict(cfg.get("positiveDcaConfig") or {})
    dca_settings["strategyMode"] = signal_mode
    dca_settings["minConfidence"] = cfg.get("minConfidence", 85)

    # Compute current daily loss state on every probe/action so UI and Risk Gate have live MT5 deal history
    daily_risk_state = compute_and_persist_daily_loss_state(
        mt5, account, cfg, open_positions=raw_positions
    )

    action_result = None
    trade_mode = int(getattr(account, "trade_mode", -1))
    is_demo_account = trade_mode == int(getattr(mt5, "ACCOUNT_TRADE_MODE_DEMO", 0))
    real_account = trade_mode == int(getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2))
    # Default fail-closed: REAL trading is blocked unless explicit multi-gate authorization passes
    live_permission = False
    if real_account:
        live_permission, _ = verify_live_execution_gate(mt5, account, terminal, cfg)

    # Note (Section 1.2): New risk-opening actions (`order`, `dca_plus`) require `live_permission` (ARMED) on REAL accounts,
    # while protective risk-reducing management of ALREADY-OPEN positions (`manage_positions`, `breakeven`, `close`)
    # remains active whenever account binding is verified (`positionManagementAllowed`) so turning off Auto/ARM never abandons SL protection!
    ok_bind_now, _ = verify_mt5_account_binding(mt5, cfg, account=account, terminal=terminal)
    protective_mgmt_allowed = is_demo_account or (real_account and (live_permission or ok_bind_now))

    if action in ("order", "dca_plus", "manage_positions", "breakeven", "close") and not (
        is_demo_account or (real_account and (live_permission if action in ("order", "dca_plus") else protective_mgmt_allowed))
    ):
        action_result = {"ok": False, "message": "Broker mutation blocked: verified DEMO account or explicit REAL ARM authorization required"}
    elif action == "order":
        manual = cfg.get("manualOrder") is True
        request_side = str(cfg.get("side", "WAIT")).upper()
        if request_side not in ("BUY", "SELL"):
            action_result = {"ok": False, "message": "BUY/SELL direction required"}
        elif not manual and (
            not entry_signal.get("allowed")
            or entry_signal.get("side") != request_side
            or int(entry_signal.get("closedM15Time", 0)) != int(cfg.get("closedM15Time", -1))
        ):
            action_result = {"ok": False, "message": "Entry blocked: latest closed M15 plan/mode no longer agrees"}
        elif not manual and len(candles) < 2:
            action_result = {"ok": False, "message": "Entry blocked: insufficient M15 candles"}
        else:
            sl_mode = str(cfg.get("slMode") or "STRUCTURAL_6_8").upper()
            if not manual:
                cfg["explicitSlPrice"] = entry_signal["sl"]
                cfg["explicitTpPrice"] = entry_signal["tp"]
                cfg["structuralInvalidationPrice"] = entry_signal.get("structuralInvalidationPrice")
                cfg["minRewardRisk"] = 1.25 if entry_signal.get("strategyMode") == "BOT_2_SIDEWAY" else 1.6
                cfg["entryReason"] = entry_signal["reason"]
                cfg["slReason"] = "Confirmed structural stop (6-8 USD/oz)"
                cfg["tpReason"] = entry_signal.get("tpReason") or "Per-strategy net RR target"
            elif sl_mode != "FIXED_CUSTOM":
                tick_now = mt5.symbol_info_tick(active_symbol)
                if tick_now is None:
                    action_result = {"ok": False, "message": "Missing quote for structural stop"}
                else:
                    entry_est = float(tick_now.ask if request_side == "BUY" else tick_now.bid)
                    plan = calc_structural_sl_and_sr_tp(
                        candles_m5, candles, candles_h1, candles_h4, request_side, entry_est,
                        float(cfg.get("slDistance") or 6.8), float(cfg.get("tpDistance") or 16.0)
                    )
                    if plan is None:
                        action_result = {
                            "ok": False,
                            "status": "WAIT_PULLBACK",
                            "message": "WAIT_PULLBACK / NEAR_OBSTACLE: Structural SL exceeds 8.0 USD/oz cap or nearest H1/H4 obstacle leaves insufficient R:R; order rejected",
                        }
                    else:
                        cfg["slDistance"], cfg["explicitSlPrice"], cfg["slReason"], cfg["tpDistance"], cfg["explicitTpPrice"], cfg["tpReason"] = plan
                        m5_cl = closed(candles_m5)
                        if len(m5_cl) >= 8:
                            cfg["structuralInvalidationPrice"] = min(b[2] for b in m5_cl[-8:]) if request_side == "BUY" else max(b[1] for b in m5_cl[-8:])
            if action_result is None:
                cfg["side"] = request_side
                cfg["liveAuthorized"] = live_permission
                action_result = execute_order(
                    mt5, active_symbol, cfg,
                    comment_tag=("V6_" + str(entry_signal.get("strategyMode") or cfg.get("strategyMode") or "MANUAL"))[:31] if not manual else "V6_MANUAL"
                )
            raw_positions = mt5.positions_get() or []

    elif action == "close":
        action_result = close_position_by_ticket(mt5, cfg.get("ticket"))
        raw_positions = mt5.positions_get() or []
    elif action == "breakeven":
        action_result = move_sl_to_breakeven(mt5, cfg.get("ticket"))
        raw_positions = mt5.positions_get() or []
    elif action == "run_backtest":
        action_result = run_historical_backtest_on_mt5(mt5, active_symbol, cfg)
    elif action == "dca_plus":
        dca_settings["liveAuthorized"] = live_permission
        dca_settings["liveArmed"] = bool(cfg.get("liveArmed", False))
        dca_settings["explicitLiveGateConfirmed"] = bool(cfg.get("explicitLiveGateConfirmed", False))
        dca_res = evaluate_and_execute_positive_dca(
            mt5,
            active_symbol,
            raw_positions,
            entry_signal,
            dca_settings,
            force_manual=bool(cfg.get("forceManual", False)),
            execute=True
        )
        action_result = {
            "ok": bool(dca_res.get("executed")),
            "submitted": bool(dca_res.get("submitted")),
            "uncertain": bool(dca_res.get("uncertain")),
            "message": dca_res.get("reason", ""),
            "dcaStatus": dca_res,
        }
        raw_positions = mt5.positions_get() or []

    trend_management_status = None
    if action == "manage_positions" and protective_mgmt_allowed:
        _tcfg = dict(cfg.get("trendManagementConfig") or {"useStructuralSl68": True, "beAtOneR": True, "enableM5StructuralTrail": True, "m15SpikeTrailDist": 10.0, "enablePartialCloseAtSr": False})
        _tcfg["positionsReadOk"] = positions_read_ok
        trend_management_status = manage_trend_and_manual_positions(
            mt5,
            active_symbol,
            raw_positions,
            candles_m5,
            candles,
            candles_h1,
            candles_h4,
            None,
            _tcfg
        )
        action_result = {"ok": True, "message": trend_management_status.get("summary", ""), "details": trend_management_status}
        raw_positions = mt5.positions_get() or []

    positive_dca_status = evaluate_and_execute_positive_dca(
        mt5,
        active_symbol,
        raw_positions,
        entry_signal,
        dca_settings,
        force_manual=False,
        execute=False
    )

    tick = mt5.symbol_info_tick(active_symbol)
    sym_info = mt5.symbol_info(active_symbol)
    bid = float(getattr(tick, "bid", 0.0) or 0.0) if tick else 0.0
    ask = float(getattr(tick, "ask", 0.0) or 0.0) if tick else 0.0
    point = float(getattr(sym_info, "point", 0.01) or 0.01) if sym_info else 0.01
    spread_points = round((ask - bid) / point, 1) if (bid > 0 and ask >= bid and point > 0) else 0.0

    mgr_state_now = _load_manager_state()
    open_positions = []
    for p in raw_positions:
        p_side = "BUY" if int(getattr(p, "type", 0)) == 0 else "SELL"
        p_open = round(float(getattr(p, "price_open", 0.0)), 2)
        p_cur = round(float(getattr(p, "price_current", 0.0)), 2)
        p_sl = round(float(getattr(p, "sl", 0.0)), 2)
        p_tp = round(float(getattr(p, "tp", 0.0)), 2)
        p_prof = round(float(getattr(p, "profit", 0.0)), 2)
        tk_id = int(getattr(p, "ticket", 0))
        p_sym = str(getattr(p, "symbol", "") or active_symbol)
        comp_k, leg3_k = _position_state_keys(live_acc_login, live_acc_server, tk_id, p_sym)
        st_rec = mgr_state_now.get(comp_k) or mgr_state_now.get(leg3_k) or {}
        state_unverified = bool(st_rec.get("stateUnverified", False)) or (not st_rec)
        raw_r_val = st_rec.get("initialR")
        persisted_r = float(raw_r_val) if (raw_r_val is not None and float(raw_r_val) > 0) else (
            round(abs(p_open - p_sl), 4) if (p_sl > 0 and ((p_side == "BUY" and p_sl < p_open) or (p_side == "SELL" and p_sl > p_open))) else None
        )
        at_be_now = is_position_at_breakeven(p)
        r_txt = f"{persisted_r:.2f}" if persisted_r is not None else "CHƯA XÁC MINH"
        if at_be_now:
            locked_pts = round((p_sl - p_open) if p_side == "BUY" else (p_open - p_sl), 2)
            hold_reason = f"Đã khóa SL dương (+{locked_pts} giá trên Entry, initialR={r_txt}), đang gồng theo cấu trúc M5 hướng tới TP ({p_tp})"
        elif p_prof > 0:
            fav_pts = round((p_cur - p_open) if p_side == "BUY" else (p_open - p_cur), 2)
            hold_reason = f"Đang có lãi (+{fav_pts} giá / +${p_prof:.2f}), xét nâng SL theo đáy/đỉnh M5 đã đóng hoặc kéo BE khi đạt 1R (+{r_txt} giá)"
        else:
            hold_reason = f"Đang trong vùng dao động cấu trúc, giữ SL bảo vệ tại {p_sl} (1R={r_txt} giá) và chờ sóng đẩy về TP {p_tp}"

        open_positions.append({
            "ticket": tk_id,
            "symbol": str(getattr(p, "symbol", "")),
            "side": p_side,
            "volume": float(getattr(p, "volume", 0.0)),
            "entry": p_open,
            "openPrice": p_open,
            "initialSl": st_rec.get("initialSl"),
            "initialR": round(persisted_r, 2) if persisted_r is not None else None,
            "favorableExtreme": st_rec.get("peak"),
            "stateStatus": "STATE_UNVERIFIED" if state_unverified else "VERIFIED",
            "stateUnverified": state_unverified,
            "reconcileFreezeDca": bool(st_rec.get("reconcileFreezeDca", False)),
            "current": p_cur,
            "currentPrice": p_cur,
            "sl": p_sl,
            "tp": p_tp,
            "reconciled": bool(st_rec.get("reconciled", False)) if st_rec else False,
            "reconcileWarning": st_rec.get("reconcileWarning"),
            "profit": p_prof,
            "atBreakeven": at_be_now,
            "holdReason": hold_reason,
            "magic": int(getattr(p, "magic", 0)),
            "comment": str(getattr(p, "comment", "")),
        })

    recent_trades = []
    try:
        now_ts = time.time()
        deals = mt5.history_deals_get(now_ts - 30 * 86400, now_ts + 86400) or []
        in_deals_by_pos = {}
        for d in deals:
            if int(getattr(d, "entry", -1)) == 0:
                pos_id = int(getattr(d, "position_id", 0) or getattr(d, "order", 0))
                if pos_id > 0:
                    in_deals_by_pos[pos_id] = d

        out_deals = [
            d for d in deals
            if int(getattr(d, "entry", 0)) in (1, 2, 3)
            and int(getattr(d, "type", -1)) in (0, 1)
            and float(getattr(d, "volume", 0.0)) > 0
        ]
        for d in reversed(out_deals[-12:]):
            deal_type = int(getattr(d, "type", 0))
            orig_side = "BUY" if deal_type == 1 else "SELL"
            pos_id = int(getattr(d, "position_id", 0) or 0)
            in_d = in_deals_by_pos.get(pos_id)
            open_p = round(float(getattr(in_d, "price", 0.0)), 2) if in_d else 0.0
            close_p = round(float(getattr(d, "price", 0.0)), 2)
            deal_time_sec = int(getattr(d, "time", 0))
            closed_at_str = datetime.datetime.fromtimestamp(deal_time_sec, tz=datetime.timezone.utc).strftime("%d/%m %H:%M:%S UTC") if deal_time_sec > 0 else "Vừa đóng"
            net_pnl = (
                float(getattr(d, "profit", 0.0))
                + float(getattr(d, "commission", 0.0))
                + float(getattr(d, "swap", 0.0))
                + float(getattr(d, "fee", 0.0) or 0.0)
            )
            raw_comment = str(getattr(d, "comment", "") or "")
            if "tp" in raw_comment.lower():
                close_reason = f"Chạm Take Profit ({close_p})"
            elif "sl" in raw_comment.lower():
                close_reason = f"Chạm Stop Loss / Trailing ({close_p})" if abs(net_pnl) > 5 else f"Chạm Hòa vốn BE ({close_p})"
            else:
                close_reason = raw_comment if raw_comment else f"Đóng lệnh tại {close_p}"

            recent_trades.append({
                "ticket": int(getattr(d, "ticket", 0)),
                "positionId": pos_id,
                "timeMs": deal_time_sec * 1000,
                "closedAt": closed_at_str,
                "symbol": str(getattr(d, "symbol", active_symbol)),
                "side": orig_side,
                "volume": round(float(getattr(d, "volume", 0.0)), 2),
                "openPrice": open_p if open_p > 0 else close_p,
                "price": close_p,
                "closePrice": close_p,
                "profit": round(net_pnl, 2),
                "closeReason": close_reason,
                "magic": int(getattr(d, "magic", 0)),
            })
    except Exception:
        pass

    term_trade_ok = bool(getattr(terminal, "trade_allowed", False))
    exp_trade_ok = bool(getattr(account, "trade_expert", False))
    trade_mode = int(getattr(account, "trade_mode", 0))
    account_mode_str = "LIVE" if trade_mode == 2 else ("CONTEST" if trade_mode == 1 else "DEMO")

    payload = {
        "connected": True,
        "actionResult": action_result,
        "positiveDcaStatus": positive_dca_status,
        "trendManagementStatus": trend_management_status,
        "dailyRiskState": daily_risk_state,
        "diagnostics": {
            "step1_api": "PASS",
            "step2_python_mt5": "PASS",
            "step3_terminal_login": "PASS",
            "step4_symbol_quote": "PASS" if bid > 0 else "WARN",
            "step5_algo_trading": "PASS" if (term_trade_ok and exp_trade_ok) else "WARN",
        },
        "accountLogin": int(account.login),
        "accountName": str(getattr(account, "name", "")),
        "accountMode": account_mode_str,
        "liveAuthorized": live_permission,
        "server": str(account.server),
        "currency": str(getattr(account, "currency", "USD")),
        "balance": round(float(getattr(account, "balance", 0.0)), 2),
        "equity": round(float(getattr(account, "equity", 0.0)), 2),
        "margin": round(float(getattr(account, "margin", 0.0)), 2),
        "freeMargin": round(float(getattr(account, "margin_free", 0.0)), 2),
        "profit": round(float(getattr(account, "profit", 0.0)), 2),
        "leverage": int(getattr(account, "leverage", 100)),
        "terminalTradeAllowed": term_trade_ok,
        "expertTradeAllowed": exp_trade_ok,
        "brokerSymbol": active_symbol,
        "availableGoldSymbols": available_gold_symbols,
        "bid": round(bid, 2),
        "ask": round(ask, 2),
        "spreadPoints": spread_points,
        "quoteFresh": fresh_sig_ok,
        "quoteAgeSeconds": round(sig_age, 2),
        "liveAnalysis": live_analysis,
        "entrySignal": entry_signal,
        "mtfAnalysis": analyze_multi_timeframe_h4_h1_m15(candles_h4, candles_h1, candles, live_analysis, bid if bid > 0 else (candles[-1][3] if candles else 4678.96), entry_signal),
        "candles": candles,
        "openPositions": open_positions,
        "recentTrades": recent_trades,
        "timestamp": int(time.time() * 1000),
    }
    mt5.shutdown()
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
