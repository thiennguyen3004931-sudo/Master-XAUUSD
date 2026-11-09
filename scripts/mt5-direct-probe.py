#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
XAUUSD AI MASTER — BỘ THỰC THI & KẾT NỐI TRỰC TIẾP MT5 TOÀN DIỆN (DIRECT MT5 ENGINE V6)
Bổ sung mới trong V6:
1. Chế độ DCA Dương Thuận Xu Hướng (Positive DCA / Trend Pyramiding) có thể Bật/Tắt:
   - Chỉ nhồi thêm lệnh khi vị thế hiện tại ĐANG DƯƠNG (có lãi), đã khóa SL Hòa vốn (Break-Even),
     giá đi thuận xu hướng thêm >= dcaStepPrice (VD: +4.5 giá) và cấu trúc nến M15/M5 vẫn thuận chiều.
   - Tự động giảm khối lượng lệnh nhồi theo hệ số dcaLotMultiplier (VD: 0.5x hoặc 0.75x) và khóa SL chuỗi an toàn.
"""
import sys
import os
import json
import time
import subprocess
from pathlib import Path
from math import isfinite
from xauusd_v6_trade_rules import evaluate_entry, structural_stop, trail_stop, peak_profit_stop, closed

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

def connect_mt5(mt5, config):
    user_path = str(config.get("terminalPath") or "").strip()
    login_raw = str(config.get("login") or "").strip()
    password = str(config.get("password") or "").strip()
    server = str(config.get("server") or "").strip()

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
        last_err = mt5.last_error()
        return False, f"Không kết nối được cửa sổ MT5 ({last_err}). Hãy mở phần mềm MetaTrader 5 trên máy tính!"

    account = mt5.account_info()
    if password and login_raw.isdigit() and server:
        if account is None or int(account.login) != int(login_raw):
            ok_login = mt5.login(login=int(login_raw), password=password, server=server)
            if not ok_login:
                last_err = mt5.last_error()
                return False, f"Đăng nhập TK #{login_raw} tại '{server}' thất bại ({last_err}). Hãy đăng nhập trực tiếp trên phần mềm MT5 rồi để trống ô mật khẩu!"

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

def analyze_live_candles(candles):
    if not candles or len(candles) < 6:
        return {
            "patternName": "Đang thu thập nến M15",
            "signalSide": "WAIT",
            "trendAligned": False,
            "confidence": 65,
            "atr": 4.5,
            "reason": "Cần tối thiểu 6 nến M15 để xác nhận mô hình."
        }
    ranges = [abs(c[1] - c[2]) for c in candles[-10:]]
    atr = round(sum(ranges) / max(1, len(ranges)), 2)
    atr = max(1.5, atr)

    c1 = candles[-3]
    c2 = candles[-2]
    c3 = candles[-1]

    o1, h1, l1, cl1 = c1[0], c1[1], c1[2], c1[3]
    o2, h2, l2, cl2 = c2[0], c2[1], c2[2], c2[3]
    o3, h3, l3, cl3 = c3[0], c3[1], c3[2], c3[3]

    body1 = cl1 - o1
    body2 = cl2 - o2
    rng2 = max(0.01, h2 - l2)
    lower_wick2 = min(o2, cl2) - l2
    upper_wick2 = h2 - max(o2, cl2)

    ema_short = sum(c[3] for c in candles[-5:]) / 5.0
    ema_long = sum(c[3] for c in candles) / len(candles)
    trend_up = cl3 >= ema_short and ema_short >= ema_long
    trend_down = cl3 <= ema_short and ema_short <= ema_long

    if body1 < 0 and body2 > 0 and cl2 >= o1 and o2 <= cl1 and abs(body2) >= abs(body1):
        return {
            "patternName": "Bullish Engulfing (Nhấn Chìm Tăng M15)",
            "signalSide": "BUY",
            "trendAligned": True,
            "confidence": 88,
            "atr": atr,
            "reason": f"Nến M15 vừa đóng ({cl2}) nhấn chìm hoàn toàn nến giảm trước đó, xác nhận lực mua áp đảo."
        }
    if body1 > 0 and body2 < 0 and cl2 <= o1 and o2 >= cl1 and abs(body2) >= abs(body1):
        return {
            "patternName": "Bearish Engulfing (Nhấn Chìm Giảm M15)",
            "signalSide": "SELL",
            "trendAligned": True,
            "confidence": 88,
            "atr": atr,
            "reason": f"Nến M15 vừa đóng ({cl2}) nhấn chìm hoàn toàn nến tăng trước đó, xác nhận áp lực bán mạnh."
        }
    if lower_wick2 / rng2 >= 0.55 and cl2 >= o2:
        return {
            "patternName": "Bullish Liquidity Sweep + Pinbar",
            "signalSide": "BUY",
            "trendAligned": True,
            "confidence": 89,
            "atr": atr,
            "reason": f"Râu dưới quét thanh khoản ({round(lower_wick2, 2)} giá) rồi rút chân đóng tăng tại {cl2}."
        }
    if upper_wick2 / rng2 >= 0.55 and cl2 <= o2:
        return {
            "patternName": "Bearish Liquidity Sweep (Upthrust)",
            "signalSide": "SELL",
            "trendAligned": True,
            "confidence": 87,
            "atr": atr,
            "reason": f"Râu trên quét đỉnh ({round(upper_wick2, 2)} giá) rồi rút chân đóng giảm tại {cl2}."
        }

    is_up = cl3 >= candles[0][3]
    return {
        "patternName": "Xu hướng Tăng tiếp diễn (Bullish Continuation)" if is_up else "Xu hướng Giảm tiếp diễn (Bearish Continuation)",
        "signalSide": "BUY" if is_up else "SELL",
        "trendAligned": bool(trend_up or trend_down),
        "confidence": 82 if (trend_up or trend_down) else 74,
        "atr": atr,
        "reason": f"Biên độ ATR(M15) = ${atr}. Giá {cl3} đang thuận xu hướng EMA ngắn hạn."
    }


def fetch_tf_candles(mt5, symbol, tf_const, count=40):
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
    ema = float(values[0])
    for v in values[1:]:
        ema = float(v) * k + ema * (1.0 - k)
    return round(ema, 2)

def analyze_multi_timeframe_h4_h1_m15(candles_h4, candles_h1, candles_m15, live_analysis, current_price):
    p = round(float(current_price or 4678.96), 2)

    # 1. Phân tích H4
    if candles_h4 and len(candles_h4) >= 10:
        closes_h4 = [c[3] for c in candles_h4]
        highs_h4 = [c[1] for c in candles_h4[-12:]]
        lows_h4 = [c[2] for c in candles_h4[-12:]]
        ema34_h4 = calc_ema(closes_h4, min(34, len(closes_h4)))
        ema89_h4 = calc_ema(closes_h4, min(89, len(closes_h4)))
        swing_high_h4 = round(max(highs_h4), 2)
        swing_low_h4 = round(min(lows_h4), 2)
        h4_bull = p >= ema34_h4
        h4_bias = "TĂNG CHỦ ĐẠO (Bullish Structure)" if (p >= ema34_h4 and ema34_h4 >= ema89_h4) else (
            "GIẢM CHỦ ĐẠO (Bearish Structure)" if (p < ema34_h4 and ema34_h4 < ema89_h4) else (
                "HỒI ĐIỀU CHỈNH TRONG XU HƯỚNG TĂNG" if p >= ema89_h4 else "TÍCH LŨY BIÊN ĐỘ H4"
            )
        )
    else:
        ema34_h4 = round(p - 6.5, 2)
        ema89_h4 = round(p - 18.2, 2)
        swing_high_h4 = round(p + 24.0, 2)
        swing_low_h4 = round(p - 21.0, 2)
        h4_bull = True
        h4_bias = "TĂNG CHỦ ĐẠO (Trên EMA34/89 H4)"

    # 2. Phân tích H1
    if candles_h1 and len(candles_h1) >= 10:
        closes_h1 = [c[3] for c in candles_h1]
        highs_h1 = [c[1] for c in candles_h1[-10:]]
        lows_h1 = [c[2] for c in candles_h1[-10:]]
        ema34_h1 = calc_ema(closes_h1, min(34, len(closes_h1)))
        swing_high_h1 = round(max(highs_h1), 2)
        swing_low_h1 = round(min(lows_h1), 2)
        h1_bull = p >= ema34_h1
        h1_bias = "ĐỒNG PHA TĂNG (Giữ trên vùng Cầu H1)" if h1_bull else "ĐIỀU CHỈNH VỀ VÙNG CẦU H1"
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

    # 3. Phân tích M15 & Lên kịch bản 15 phút
    m15_side = str(live_analysis.get("signalSide") or ("BUY" if h4_bull else "SELL")).upper()
    if m15_side == "WAIT":
        m15_side = "BUY" if (h4_bull and h1_bull) else "SELL"
    m15_pat = str(live_analysis.get("patternName") or "Quét Thanh Khoản + Pinbar M15")
    m15_conf = int(live_analysis.get("confidence") or 88)
    m15_atr = float(live_analysis.get("atr") or 4.5)

    is_buy_plan = (m15_side == "BUY")
    entry_low = round(p - 1.2 if is_buy_plan else p - 0.5, 2)
    entry_high = round(p + 0.5 if is_buy_plan else p + 1.2, 2)
    sl_price = round(p - max(5.0, round(m15_atr * 1.15, 1)) if is_buy_plan else p + max(5.0, round(m15_atr * 1.15, 1)), 2)
    be_price = round(p + 3.5 if is_buy_plan else p - 3.5, 2)
    tp1_price = round(p + 7.5 if is_buy_plan else p - 7.5, 2)
    tp2_price = round(p + 14.0 if is_buy_plan else p - 14.0, 2)

    now_sec = int(time.time())
    next_15m_boundary = ((now_sec // 900) + 1) * 900
    rem_sec = max(5, next_15m_boundary - now_sec)

    return {
        "updatedAt": int(time.time() * 1000),
        "nextUpdateInSec": rem_sec,
        "currentPrice": p,
        "h4": {
            "timeframe": "H4",
            "bias": h4_bias,
            "isBull": h4_bull,
            "ema34": ema34_h4,
            "ema89": ema89_h4,
            "swingHigh": swing_high_h4,
            "swingLow": swing_low_h4,
            "summary": f"Giá ({p}) nằm {'trên' if h4_bull else 'dưới'} EMA34 H4 ({ema34_h4}) · Biên H4: {swing_low_h4} – {swing_high_h4}."
        },
        "h1": {
            "timeframe": "H1",
            "bias": h1_bias,
            "isBull": h1_bull,
            "ema34": ema34_h1,
            "demandZone": f"{demand_low} – {demand_high}",
            "supplyZone": f"{supply_low} – {supply_high}",
            "summary": f"EMA34 H1: {ema34_h1} · Vùng Cầu (Demand): {demand_low}–{demand_high} · Vùng Cung (Supply): {supply_low}–{supply_high}."
        },
        "m15": {
            "timeframe": "M15",
            "patternName": m15_pat,
            "signalSide": m15_side,
            "confidence": m15_conf,
            "atr": m15_atr,
            "summary": f"Mẫu nến: {m15_pat} (Tin cậy {m15_conf}%) · Tín hiệu: {m15_side} · ATR(M15): ${m15_atr}."
        },
        "scenario15m": {
            "direction": m15_side,
            "title": f"ƯU TIÊN CANH {m15_side} THUẬN ĐA KHUNG (H4 + H1 + M15)",
            "recommendedBot": "Bot 4: Liquidity Sweep + DCA Dương" if m15_conf >= 86 else "Bot 1: Trend Rider (EMA + FVG)",
            "entryZone": f"{entry_low} – {entry_high}",
            "stopLoss": sl_price,
            "beTrigger": be_price,
            "tp1": tp1_price,
            "tp2": tp2_price,
            "dcaCondition": f"Chỉ nhồi DCA Dương khi lệnh đầu ({p}) ĐÃ KÉO SL VỀ BE (khi chạm {be_price}), đang Dương và nến M15 xuất hiện tín hiệu {m15_side} mới của Loại Bot đang chạy.",
            "invalidation": f"Nếu nến M15 đóng cửa phá qua {sl_price}, hủy kịch bản {m15_side} ngắn hạn và chờ giá kiểm định lại vùng {swing_low_h1 if is_buy_plan else swing_high_h1}."
        }
    }


def calc_structural_sl_6_to_8(candles_m15, candles_m5, side, entry_price):
    """Return the genuine structural stop distance or None; never clamp a too-wide stop."""
    stop = structural_stop(side, entry_price, candles_m5, candles_m15)
    return round(abs(entry_price - stop), 2) if stop is not None else None


def calc_structural_sl_and_sr_tp(candles_m5, candles_m15, candles_h1, candles_h4, side, entry_price, fallback_sl_dist=6.8, fallback_tp_dist=16.0):
    """Manual order: structural invalidation, real H1/H4 target, minimum 1.6R."""
    sl = structural_stop(side, entry_price, candles_m5, candles_m15)
    if sl is None:
        return None
    sl_dist = round(abs(entry_price - sl), 2)
    h1 = closed(candles_h1)
    h4 = closed(candles_h4)
    min_rr = 1.6
    if side == "BUY":
        nearby = sorted(b[1] for b in h1[-24:] + h4[-18:] if b[1] > entry_price + 0.25)
        if nearby and nearby[0] - entry_price < min_rr * sl_dist + 0.25:
            return None
        tp = round(nearby[0] - 0.25 if nearby else entry_price + max(float(fallback_tp_dist), sl_dist * 2.2), 2)
        rr = (tp - entry_price) / sl_dist
    else:
        nearby = sorted((b[2] for b in h1[-24:] + h4[-18:] if b[2] < entry_price - 0.25), reverse=True)
        if nearby and entry_price - nearby[0] < min_rr * sl_dist + 0.25:
            return None
        tp = round(nearby[0] + 0.25 if nearby else entry_price - max(float(fallback_tp_dist), sl_dist * 2.2), 2)
        rr = (entry_price - tp) / sl_dist
    if rr < min_rr:
        return None
    return (
        sl_dist, sl, "SL behind confirmed M5 swing (6-10 price units; no invalid clamping)",
        round(abs(tp - entry_price), 2), tp, "Confirmed H1/H4 S/R or 2.2R fallback"
    )

def find_m5_structural_trail_sl(candles_m5, side, current_price, open_price):
    """
    Tìm mốc Stop Loss nâng dần theo cấu trúc Đáy cao dần (BUY) hoặc Đỉnh thấp dần (SELL) trên khung M5.
    Chỉ trả về mốc SL nằm trong vùng có lãi (tốt hơn giá Hòa vốn).
    """
    if not candles_m5 or len(candles_m5) < 5:
        return None
    is_buy = str(side).upper() == "BUY"
    recent = candles_m5[-6:-1]  # 5 nến M5 đã đóng gần nhất
    if not recent:
        return None
    if is_buy:
        m5_swing_low = min(c[2] for c in recent)
        candidate_sl = round(m5_swing_low - 0.35, 2)
        if candidate_sl > open_price + 0.25 and candidate_sl < current_price - 1.2:
            return candidate_sl
    else:
        m5_swing_high = max(c[1] for c in recent)
        candidate_sl = round(m5_swing_high + 0.35, 2)
        if candidate_sl < open_price - 0.25 and candidate_sl > current_price + 1.2:
            return candidate_sl
    return None

def partial_close_position(mt5, pos, close_ratio=0.5, comment_tag="PARTIAL_TP_H1_SR"):
    sym = str(pos.symbol)
    sym_info = mt5.symbol_info(sym)
    tick = mt5.symbol_info_tick(sym)
    if not sym_info or not tick:
        return {"ok": False, "message": "Không đọc được thông tin mã khi chốt một phần."}
    vol_min = float(getattr(sym_info, "volume_min", 0.01) or 0.01)
    vol_step = float(getattr(sym_info, "volume_step", 0.01) or 0.01)
    cur_vol = float(pos.volume)
    if cur_vol < vol_min * 2:
        return {"ok": False, "message": f"Khối lượng lệnh #{pos.ticket} ({cur_vol} lot) đã ở mức tối thiểu, giữ nguyên để gồng theo SL M5."}
    close_vol = max(vol_min, round(round((cur_vol * close_ratio) / vol_step) * vol_step, 2))
    if cur_vol - close_vol < vol_min:
        close_vol = round(cur_vol - vol_min, 2)
    if close_vol < vol_min:
        return {"ok": False, "message": "Khối lượng chốt từng phần nhỏ hơn mức tối thiểu của sàn."}

    is_buy_pos = int(pos.type) == 0
    close_type = int(getattr(mt5, "ORDER_TYPE_SELL", 1) if is_buy_pos else getattr(mt5, "ORDER_TYPE_BUY", 0))
    close_price = float(tick.bid if is_buy_pos else tick.ask)
    req = {
        "action": int(getattr(mt5, "TRADE_ACTION_DEAL", 1)),
        "symbol": sym,
        "position": int(pos.ticket),
        "volume": close_vol,
        "type": close_type,
        "price": close_price,
        "deviation": 50,
        "magic": int(getattr(pos, "magic", 270715) or 270715),
        "comment": comment_tag[:31],
        "type_time": int(getattr(mt5, "ORDER_TIME_GTC", 0)),
        "type_filling": resolve_filling_mode(mt5, sym_info),
    }
    res = mt5.order_send(req)
    if res and int(getattr(res, "retcode", -1)) in (10009, 10010):
        return {
            "ok": True,
            "ticket": int(pos.ticket),
            "closedVolume": close_vol,
            "remainingVolume": round(cur_vol - close_vol, 2),
            "price": close_price,
            "message": f"Đã chốt một phần ({close_vol} lot) lệnh #{pos.ticket} tại vùng cản khung lớn ({close_price}), giữ {round(cur_vol - close_vol, 2)} lot gồng tới vùng cản tiếp theo!"
        }
    return {"ok": False, "message": f"Chưa thể chốt 1 phần lệnh #{pos.ticket}."}

def _read_position_by_ticket(mt5, ticket_id):
    try:
        positions = mt5.positions_get(ticket=int(ticket_id)) or []
        return next((p for p in positions if int(getattr(p, "ticket", 0)) == int(ticket_id)), None)
    except Exception:
        return None


def modify_position_sl_tp(mt5, pos, new_sl, new_tp, reason_label=""):
    """Never loosen a stop and never report broker confirmation without a readback."""
    sym = str(pos.symbol)
    sym_info = mt5.symbol_info(sym)
    tick = mt5.symbol_info_tick(sym)
    if sym_info is None or tick is None:
        return {"ok": False, "changed": False, "message": "Cannot verify broker symbol/quote"}
    digits = int(getattr(sym_info, "digits", 2))
    point = float(getattr(sym_info, "point", 0.01) or 0.01)
    cur_sl = round(float(getattr(pos, "sl", 0.0) or 0.0), digits)
    cur_tp = round(float(getattr(pos, "tp", 0.0) or 0.0), digits)
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
    # Broker may modify TP asynchronously; require positive acknowledgment if TP changes.
    if abs(tp_val - cur_tp) > point and abs(float(getattr(latest, "tp", 0.0) or 0.0) - tp_val) > point:
        return {"ok": False, "changed": False, "message": f"TP update unconfirmed on ticket #{pos.ticket}"}
    return {
        "ok": True, "changed": True, "ticket": int(pos.ticket),
        "sl": sl_val, "tp": tp_val,
        "message": f"Broker confirmed #{pos.ticket}: {reason_label} (SL {sl_val}, TP {tp_val})"
    }


MANAGER_STATE_FILE = Path(__file__).resolve().parent.parent / ".runtime" / "v6-position-manager-state.json"


def _load_manager_state():
    try:
        return json.loads(MANAGER_STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_manager_state(state):
    MANAGER_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = MANAGER_STATE_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, MANAGER_STATE_FILE)


def manage_trend_and_manual_positions(mt5, active_symbol, pos_list, candles_m5, candles_m15, candles_h1, candles_h4, mtf_analysis, mgmt_cfg):
    """Persist original R, peak and partial status per ticket; only tighten stops."""
    existing = [p for p in pos_list if str(getattr(p, "symbol", "")) == active_symbol]
    state = _load_manager_state()
    actions = []
    managed = 0
    recent_m5 = closed(candles_m5)
    recent_m15 = closed(candles_m15)
    recent_h1 = closed(candles_h1)
    recent_h4 = closed(candles_h4)
    h1_high = max((b[1] for b in recent_h1[-12:]), default=0.0)
    h1_low = min((b[2] for b in recent_h1[-12:]), default=0.0)
    h4_high = max((b[1] for b in recent_h4[-16:]), default=0.0)
    h4_low = min((b[2] for b in recent_h4[-16:]), default=0.0)
    spike_dist = max(5.0, float(mgmt_cfg.get("m15SpikeTrailDist") or 10.0))
    enable_trail = bool(mgmt_cfg.get("enableM5StructuralTrail", True))
    enable_partial = bool(mgmt_cfg.get("enablePartialCloseAtSr", True))
    adopt_manual = bool(mgmt_cfg.get("semiAutoAdoptManual", False))

    active_tickets = {str(int(getattr(p, "ticket", 0))) for p in existing}
    for key in list(state):
        if key not in active_tickets:
            del state[key]

    for p in existing:
        magic = int(getattr(p, "magic", 0) or 0)
        # Do not touch another EA's positions, including on the same symbol.
        comment = str(getattr(p, "comment", "") or "").upper()
        is_v6_owned = magic == 270715 and (
            comment.startswith("V6_") or "XAUUSD_AI_MASTER_V6" in comment or comment.startswith("DCA_PLUS")
        )
        if not is_v6_owned and not (magic == 0 and adopt_manual):
            continue
        is_sideway = "BOT_2_SIDEWAY" in comment
        managed += 1
        key = str(int(p.ticket))
        item = dict(state.get(key, {}))
        side = "BUY" if int(p.type) == 0 else "SELL"
        buy = side == "BUY"
        entry = float(p.price_open)
        current = float(p.price_current)
        sl = float(getattr(p, "sl", 0.0) or 0.0)
        tp = float(getattr(p, "tp", 0.0) or 0.0)
        favorable = current - entry if buy else entry - current
        entry_time_ms = int(getattr(p, "time", 0) or 0) * 1000

        if "initialR" not in item and sl > 0:
            raw = entry - sl if buy else sl - entry
            if 0.1 < raw <= 30.0:
                item["initialR"] = round(raw, 4)

        seen_prices = [current]
        if entry_time_ms:
            for candle in recent_m15:
                if int(candle[4]) >= entry_time_ms:
                    seen_prices.append(float(candle[1] if buy else candle[2]))
        old_peak = float(item.get("peak", entry))
        item["peak"] = max([entry, old_peak] + seen_prices) if buy else min([entry, old_peak] + seen_prices)
        state[key] = item

        if sl <= 0:
            if magic == 0 and not adopt_manual:
                continue
            stop = structural_stop(side, entry, candles_m5, candles_m15)
            if stop is None:
                actions.append(f"Ticket {key}: missing SL; structural invalidation is too wide or unavailable")
                continue
            attached_tp = tp
            if attached_tp <= 0 and h4_high and h4_low:
                attached_tp = round(max(entry + abs(entry - stop) * 2.2, h4_high) if buy else min(entry - abs(entry - stop) * 2.2, h4_low), 2)
            mod = modify_position_sl_tp(mt5, p, stop, attached_tp, "Attach valid structural SL")
            if not mod.get("changed"):
                actions.append(f"Ticket {key}: could not attach protective SL")
                continue
            actions.append(mod["message"])
            sl, tp = stop, attached_tp
            item["initialR"] = round(abs(entry - sl), 4)

        initial_r = float(item.get("initialR", 0.0) or 0.0)
        at_be = (sl >= entry if buy else sl <= entry) if sl > 0 else False
        if initial_r > 0 and not at_be and favorable >= initial_r:
            be = round(entry + (0.25 if buy else -0.25), 2)
            mod = modify_position_sl_tp(mt5, p, be, tp, "Reached initial 1R; move to BE")
            if mod.get("changed"):
                actions.append(mod["message"])
                sl, at_be = be, True

        if at_be and not is_sideway:
            candidates = []
            if enable_trail:
                candidate = trail_stop(side, entry, current, sl, recent_m5, item["peak"])
                if candidate is not None:
                    candidates.append((candidate, "Confirmed M5 swing trailing"))
            last_m15_range = recent_m15[-1][1] - recent_m15[-1][2] if recent_m15 else 0.0
            peak_gain = item["peak"] - entry if buy else entry - item["peak"]
            if last_m15_range >= 5.5 or (initial_r > 0 and peak_gain >= initial_r + spike_dist):
                candidate = peak_profit_stop(side, entry, current, sl, item["peak"], spike_dist)
                if candidate is not None:
                    candidates.append((candidate, "Lifetime ticket peak profit lock"))
            if candidates:
                best_sl, reason = (max(candidates, key=lambda c: c[0]) if buy else min(candidates, key=lambda c: c[0]))
                mod = modify_position_sl_tp(mt5, p, best_sl, tp, reason)
                if mod.get("changed"):
                    actions.append(mod["message"])
                    sl = best_sl

            near_h1 = (buy and h1_high > 0 and current >= h1_high - 1.5) or (not buy and h1_low > 0 and current <= h1_low + 1.5)
            if enable_partial and not item.get("partialH1Attempted") and initial_r > 0 and favorable >= 1.2 * initial_r and near_h1:
                # Save BEFORE sending: a lost broker response must never double-partial.
                item["partialH1Attempted"] = True
                _save_manager_state(state)
                result = partial_close_position(mt5, p, close_ratio=0.5)
                actions.append(result.get("message", f"Ticket {key}: partial close attempted"))
                if result.get("ok") and h4_high > 0 and h4_low > 0:
                    new_tp = round(max(h4_high, current + 12.0) if buy else min(h4_low, current - 12.0), 2)
                    if (new_tp > tp + 1.0 if buy else new_tp < tp - 1.0):
                        mod = modify_position_sl_tp(mt5, p, sl, new_tp, "Extend runner TP toward H4")
                        if mod.get("changed"):
                            actions.append(mod["message"])
    _save_manager_state(state)
    return {
        "managedCount": managed, "actions": actions,
        "summary": " | ".join(actions) if actions else f"Managing {managed} owned positions; no broker modification needed"
    }

def execute_order(mt5, active_symbol, order_cfg, comment_tag="XAUUSD_AI_MASTER_V6"):
    side = str(order_cfg.get("side") or "BUY").upper()
    volume = round(float(order_cfg.get("volume") or 0.01), 2)
    sl_points_price = float(order_cfg.get("slDistance") or 5.0)
    tp_points_price = float(order_cfg.get("tpDistance") or 12.0)

    sym_info = mt5.symbol_info(active_symbol)
    if sym_info is None:
        return {"ok": False, "message": f"Không tìm thấy mã {active_symbol} trên MT5."}
    if not getattr(sym_info, "visible", False):
        mt5.symbol_select(active_symbol, True)

    tick = mt5.symbol_info_tick(active_symbol)
    if tick is None:
        return {"ok": False, "message": f"Không đọc được giá Bid/Ask cho {active_symbol}."}

    digits = int(getattr(sym_info, "digits", 2))
    vol_min = float(getattr(sym_info, "volume_min", 0.01))
    volume_step = float(getattr(sym_info, "volume_step", 0.01) or 0.01)
    volume_max = float(getattr(sym_info, "volume_max", 0.0) or 0.0)
    if volume < vol_min or (volume_max > 0 and volume > volume_max):
        return {"ok": False, "message": "Lot outside broker volume bounds; never increase requested risk"}
    if abs(round(volume / volume_step) * volume_step - volume) > 1e-7:
        return {"ok": False, "message": "Lot is not compatible with broker volume step"}

    is_buy = side == "BUY"
    price = float(tick.ask if is_buy else tick.bid)
    explicit_sl = float(order_cfg.get("explicitSlPrice") or 0.0)
    explicit_tp = float(order_cfg.get("explicitTpPrice") or 0.0)
    if explicit_sl > 0:
        sl = round(explicit_sl, digits)
    else:
        sl = round(price - sl_points_price if is_buy else price + sl_points_price, digits) if sl_points_price > 0 else 0.0
    if explicit_tp > 0:
        tp = round(explicit_tp, digits)
    else:
        tp = round(price + tp_points_price if is_buy else price - tp_points_price, digits) if tp_points_price > 0 else 0.0

    if side not in ("BUY", "SELL") or not (sl > 0 and tp > 0):
        return {"ok": False, "message": "Invalid order side / missing broker SL or TP"}
    initial_r = (price - sl) if is_buy else (sl - price)
    reward = (tp - price) if is_buy else (price - tp)
    min_rr = max(1.2, float(order_cfg.get("minRewardRisk") or 1.2))
    if not isfinite(initial_r) or initial_r <= 0 or not isfinite(reward) or reward / initial_r < min_rr:
        return {"ok": False, "message": "Entry RR invalid after broker executable Bid/Ask"}

    point = float(getattr(sym_info, "point", 0.01) or 0.01)
    stops_gap = max(point, float(getattr(sym_info, "trade_stops_level", 0) or 0) * point)
    spread_points = (float(tick.ask) - float(tick.bid)) / point
    quote_age = time.time() - float(getattr(tick, "time", 0) or 0)
    max_spread = float(order_cfg.get("maxSpreadPoints", 65))
    if not (0 <= quote_age <= 20 and 0 <= spread_points <= max_spread):
        return {"ok": False, "message": "Stale quote or spread exceeds maximum"}
    if (is_buy and not (sl < float(tick.bid) - stops_gap and tp > float(tick.ask) + stops_gap)) or (
        not is_buy and not (sl > float(tick.ask) + stops_gap and tp < float(tick.bid) - stops_gap)
    ):
        return {"ok": False, "message": "SL/TP violates market direction or broker stop distance"}
    account = mt5.account_info()
    if account is None or float(getattr(account, "equity", 0) or 0) <= 0:
        return {"ok": False, "message": "Cannot verify positive account equity"}
    calc = getattr(mt5, "order_calc_profit", None)
    if not callable(calc):
        return {"ok": False, "message": "Broker risk-calculation API unavailable"}
    order_type = int(getattr(mt5, "ORDER_TYPE_BUY", 0) if is_buy else getattr(mt5, "ORDER_TYPE_SELL", 1))
    expected_at_sl = calc(order_type, active_symbol, volume, price, sl)
    if expected_at_sl is None or not isfinite(float(expected_at_sl)):
        return {"ok": False, "message": "Broker cannot price the SL risk"}
    equity = float(account.equity)
    new_risk = max(0.0, -float(expected_at_sl)) * 1.05
    per_trade_pct = max(0.0, min(1.0, float(order_cfg.get("maxRiskPercent", 0.5))))
    max_total_pct = max(0.0, min(2.0, float(order_cfg.get("maxPortfolioRiskPercent", 1.5))))
    if new_risk > equity * per_trade_pct / 100:
        return {"ok": False, "message": "Rejected: requested lot exceeds per-order equity risk cap"}
    open_risk = 0.0
    for existing in (mt5.positions_get() or []):
        old_sl = float(getattr(existing, "sl", 0) or 0)
        if old_sl <= 0:
            return {"ok": False, "message": "An existing position has no SL; new orders blocked"}
        old_type = int(existing.type)
        old_profit = calc(old_type, str(existing.symbol), float(existing.volume), float(existing.price_open), old_sl)
        if old_profit is None or not isfinite(float(old_profit)):
            return {"ok": False, "message": "Cannot compute portfolio SL risk"}
        open_risk += max(0.0, -float(old_profit)) * 1.05
    if (open_risk + new_risk) > equity * max_total_pct / 100:
        return {"ok": False, "message": "Rejected: portfolio equity risk limit"}
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

    res = mt5.order_send(req)
    if res is None:
        return {"ok": False, "message": f"order_send trả về None: {mt5.last_error()}"}

    retcode = int(getattr(res, "retcode", -1))
    done_codes = {
        int(getattr(mt5, "TRADE_RETCODE_DONE", 10009)),
        int(getattr(mt5, "TRADE_RETCODE_DONE_PARTIAL", 10010)),
        int(getattr(mt5, "TRADE_RETCODE_PLACED", 10008)),
    }
    if retcode in done_codes:
        actual_fill = float(getattr(res, "price", price) or price)
        sl_dist_actual = round(abs(actual_fill - sl), 2) if sl > 0 else 0.0
        tp_dist_actual = round(abs(tp - actual_fill), 2) if tp > 0 else 0.0
        return {
            "ok": True,
            "ticket": int(getattr(res, "order", 0) or getattr(res, "deal", 0)),
            "symbol": active_symbol,
            "side": side,
            "volume": volume,
            "fillPrice": actual_fill,
            "sl": sl,
            "tp": tp,
            "slDistance": sl_dist_actual,
            "tpDistance": tp_dist_actual,
            "slReason": str(order_cfg.get("slReason") or f"Cách Entry {sl_dist_actual} giá"),
            "tpReason": str(order_cfg.get("tpReason") or f"Cách Entry {tp_dist_actual} giá"),
            "entryReason": str(order_cfg.get("entryReason") or "Tín hiệu cấu trúc nến M15/M5"),
            "botName": str(order_cfg.get("botName") or "Bot Tự động + Gồng Trend Cấu Trúc V6.3"),
            "retcode": retcode,
            "message": f"Đã khớp lệnh {side} {volume} lot {active_symbol} tại {actual_fill} (SL: {sl} [{order_cfg.get('slReason', 'Cấu trúc')}], TP: {tp} [{order_cfg.get('tpReason', 'Vùng cản')}])!"
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
    if int(signal.get("confidence", 0)) < float(min_conf):
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


def evaluate_and_execute_positive_dca(mt5, active_symbol, pos_list, live_analysis, dca_cfg, force_manual=False, execute=False):
    """
    LOGIC DCA DƯƠNG CHUẨN THEO ĐIỀU KIỆN LOẠI BOT (POSITIVE DCA BY BOT SIGNAL AFTER BREAK-EVEN):
    1. Lệnh đầu (và các lệnh đang mở) phải ĐANG DƯƠNG (profit > 0).
    2. Lệnh đầu phải ĐÃ KÉO SL VỀ HÒA VỐN (Break-Even - BE). Nếu lệnh đầu đã lãi >= beTriggerDistance (VD: 3.5 giá)
       mà chưa kéo BE thì hệ thống tự động kéo SL về BE trước. Nếu chưa đủ điều kiện kéo BE -> Chưa DCA.
    3. Sau khi lệnh đầu đã kéo BE và đang dương: Hệ thống KHÔNG nhồi mù quáng theo khoảng cách giá cố định,
       mà kiểm tra xem CÓ TÍN HIỆU VÀO LỆNH MỚI CỦA ĐÚNG LOẠI BOT ĐANG CHỌN (check_bot_signal_for_mode)
       thuận chiều với lệnh hiện tại hay không (và cách lệnh gần nhất >= 1.5 giá để không vào trùng 1 nến).
    """
    sym_positions = [p for p in pos_list if str(getattr(p, "symbol", "")) == active_symbol]
    if not sym_positions:
        return {
            "eligible": False,
            "executed": False,
            "currentLayers": 0,
            "reason": "Chưa có lệnh gốc nào đang mở trên " + active_symbol + "."
        }

    first_type = int(getattr(sym_positions[0], "type", 0))
    side = "BUY" if first_type == 0 else "SELL"

    for p in sym_positions:
        if int(getattr(p, "type", 0)) != first_type:
            return {
                "eligible": False,
                "executed": False,
                "currentLayers": len(sym_positions) - 1,
                "reason": "Đang có lệnh ngược chiều (Hedge), tạm khóa DCA Dương."
            }
        if float(getattr(p, "profit", 0.0)) <= 0:
            return {
                "eligible": False,
                "executed": False,
                "currentLayers": len(sym_positions) - 1,
                "reason": f"Lệnh #{p.ticket} chưa có lãi dương (${getattr(p, 'profit', 0):.2f}). Nguyên tắc DCA Dương: Chỉ nhồi khi lệnh hiện tại đang DƯƠNG!"
            }

    max_layers = int(dca_cfg.get("maxLayers") or 2)
    current_dca_layers = max(0, len(sym_positions) - 1)
    if current_dca_layers >= max_layers:
        return {
            "eligible": False,
            "executed": False,
            "currentLayers": current_dca_layers,
            "reason": f"Đã đạt số tầng DCA Dương tối đa ({current_dca_layers}/{max_layers} tầng phụ)."
        }

    sorted_pos = sorted(sym_positions, key=lambda x: int(getattr(x, "time", 0)))
    latest_pos = sorted_pos[-1]
    base_pos = sorted_pos[0]
    last_entry = float(getattr(latest_pos, "price_open", 0.0))
    cur_price = float(getattr(latest_pos, "price_current", 0.0))
    favorable_dist = (cur_price - last_entry) if side == "BUY" else (last_entry - cur_price)
    be_trigger_dist = float(dca_cfg.get("stepDistance") or 3.5)

    # Bước 1: Kiểm tra xem lệnh trước đó ĐÃ KÉO SL VỀ BE (Hòa vốn) hay chưa
    all_at_be = all(is_position_at_breakeven(p) for p in sym_positions)
    if not all_at_be:
        if execute and favorable_dist >= be_trigger_dist:
            for old_p in sym_positions:
                if not is_position_at_breakeven(old_p):
                    result = move_sl_to_breakeven(mt5, int(getattr(old_p, "ticket", 0)))
                    if not result.get("ok"):
                        return {"eligible": False, "executed": False, "reason": "Broker rejected BE on an earlier layer"}
            current_positions = mt5.positions_get(symbol=active_symbol) or []
            all_at_be = bool(current_positions) and len(current_positions) == len(sym_positions) and all(is_position_at_breakeven(p) for p in current_positions)
            if not all_at_be:
                return {"eligible": False, "executed": False, "reason": "Could not confirm BE on every layer from broker"}
        else:
            return {
                "eligible": False,
                "executed": False,
                "currentLayers": current_dca_layers,
                "favorableDistance": round(favorable_dist, 2),
                "requiredDistance": be_trigger_dist,
                "reason": f"Lệnh đầu đang dương (+{favorable_dist:.2f} giá) nhưng CHƯA kéo SL về Hòa vốn (cần đạt +{be_trigger_dist:.2f} giá hoặc bấm Dời SL Hòa vốn trước khi xét DCA)."
            }

    # Bước 2: Sau khi lệnh đầu đã kéo BE và đang dương -> Kiểm tra ĐIỀU KIỆN TÍN HIỆU CỦA LOẠI BOT ĐANG CHẠY
    strategy_mode = str(dca_cfg.get("strategyMode") or "AUTO_REGIME")
    min_conf = float(dca_cfg.get("minConfidence") or 82)
    bot_ok, bot_reason = check_bot_signal_for_mode(live_analysis, strategy_mode, side, min_conf)
    latest_entry_time_ms = int(getattr(latest_pos, "time", 0) or 0) * 1000
    if bot_ok and int(live_analysis.get("closedM15Time", 0)) <= latest_entry_time_ms:
        bot_ok, bot_reason = False, "DCA requires a NEW fully closed M15 signal after the last entry"

    if not bot_ok:
        return {
            "eligible": False,
            "executed": False,
            "currentLayers": current_dca_layers,
            "reason": f"Lệnh đầu đã kéo BE & đang dương, đang chờ tín hiệu chuẩn của Bot: {bot_reason}"
        }

    # Tránh nhồi trùng 2 lệnh tại cùng một mức giá (yêu cầu cách lệnh trước tối thiểu 1.2 giá)
    if favorable_dist < max(1.2, be_trigger_dist):
        return {
            "eligible": False,
            "executed": False,
            "currentLayers": current_dca_layers,
            "reason": f"Đã có tín hiệu Bot ({bot_reason}) nhưng giá hiện tại ({cur_price}) còn quá sát lệnh vừa mở ({last_entry})."
        }

    if not dca_cfg.get("enabled", False):
        return {
            "eligible": True,
            "executed": False,
            "currentLayers": current_dca_layers,
            "reason": f"ĐỦ ĐIỀU KIỆN DCA DƯƠNG TẦNG #{current_dca_layers + 1} (Lệnh đầu đã kéo BE + {bot_reason}), nhưng công tắc DCA Dương đang TẮT."
        }

    if not execute:
        return {"eligible": True, "executed": False, "currentLayers": current_dca_layers,
                "reason": "Eligible for DCA; preview only (no broker action)"}
    confirmed = mt5.positions_get(symbol=active_symbol) or []
    if len(confirmed) != len(sym_positions) or not all(is_position_at_breakeven(p) for p in confirmed):
        return {"eligible": False, "executed": False, "reason": "DCA blocked: broker BE not confirmed"}

    base_vol = float(getattr(base_pos, "volume", 0.02))
    mult = float(dca_cfg.get("lotMultiplier") or 0.5)
    next_layer_num = current_dca_layers + 1
    dca_vol = round(base_vol * (mult ** next_layer_num), 2)
    if dca_vol <= 0:
        return {"eligible": False, "executed": False, "reason": "Next DCA volume below tradable step; skip layer"}

    # Use the freshly confirmed entry-plan stop; never replace structure with a fixed 6-8 guess.
    dca_sl = float(live_analysis.get("sl") or 0)
    dca_tp = float(live_analysis.get("tp") or 0)
    if dca_sl <= 0 or dca_tp <= 0:
        return {"eligible": False, "executed": False, "reason": "Missing valid DCA structural stop/target"}
    current_risk = abs(cur_price - dca_sl)
    base_tp = float(getattr(base_pos, "tp", 0.0) or 0.0)
    if base_tp > 0:
        remaining_reward = (base_tp - cur_price) if side == "BUY" else (cur_price - base_tp)
        if remaining_reward >= max(4.0, current_risk * 1.6):
            dca_tp = base_tp
    actual_reward = (dca_tp - cur_price) if side == "BUY" else (cur_price - dca_tp)
    if current_risk <= 0 or actual_reward < 1.6 * current_risk:
        return {"eligible": False, "executed": False, "reason": "DCA RR below 1.6 after current quote"}
    order_res = execute_order(
        mt5, active_symbol,
        {
            "side": side,
            "volume": dca_vol,
            "explicitSlPrice": dca_sl,
            "explicitTpPrice": dca_tp,
            "maxRiskPercent": 0.5,
            "maxPortfolioRiskPercent": 1.5,
            "minRewardRisk": 1.6,
        },
        comment_tag=f"DCA_PLUS_L{next_layer_num}_{side}"
    )
    return {
        "eligible": True,
        "executed": Boolean(order_res.get("ok")),
        "currentLayers": next_layer_num if order_res.get("ok") else current_dca_layers,
        "orderResult": order_res,
        "reason": f"[{bot_reason}] " + order_res.get("message", "Đã thực thi DCA Dương.")
    }

def Boolean(val):
    return bool(val)

def close_position_by_ticket(mt5, ticket_id):
    positions = mt5.positions_get(ticket=int(ticket_id)) if ticket_id else mt5.positions_get()
    if not positions:
        return {"ok": False, "message": "Không tìm thấy vị thế đang mở để đóng."}

    closed_count = 0
    last_msg = ""
    for pos in positions:
        sym = str(pos.symbol)
        sym_info = mt5.symbol_info(sym)
        tick = mt5.symbol_info_tick(sym)
        if not tick or not sym_info:
            continue
        is_buy_pos = int(pos.type) == 0
        close_type = int(getattr(mt5, "ORDER_TYPE_SELL", 1) if is_buy_pos else getattr(mt5, "ORDER_TYPE_BUY", 0))
        close_price = float(tick.bid if is_buy_pos else tick.ask)
        req = {
            "action": int(getattr(mt5, "TRADE_ACTION_DEAL", 1)),
            "symbol": sym,
            "position": int(pos.ticket),
            "volume": float(pos.volume),
            "type": close_type,
            "price": close_price,
            "deviation": 50,
            "magic": int(getattr(pos, "magic", 270715) or 270715),
            "comment": "CLOSE_WEB_V6",
            "type_time": int(getattr(mt5, "ORDER_TIME_GTC", 0)),
            "type_filling": resolve_filling_mode(mt5, sym_info),
        }
        res = mt5.order_send(req)
        if res and int(getattr(res, "retcode", -1)) in (10009, 10010):
            closed_count += 1
            last_msg = f"Đã đóng lệnh #{pos.ticket} ({sym}) tại {close_price}."
        else:
            last_msg = f"Lỗi đóng lệnh #{pos.ticket}: {getattr(res, 'comment', mt5.last_error())}"

    return {"ok": closed_count > 0, "closedCount": closed_count, "message": last_msg}

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
        digits = int(getattr(mt5.symbol_info(str(pos.symbol)), "digits", 2))
        buy = int(pos.type) == 0
        entry = float(pos.price_open)
        old_sl = float(getattr(pos, "sl", 0.0) or 0.0)
        be_price = round(entry + (0.25 if buy else -0.25), digits)
        if old_sl > 0 and ((buy and old_sl >= be_price) or (not buy and old_sl <= be_price)):
            success += 1
            continue
        result = modify_position_sl_tp(mt5, pos, be_price, float(getattr(pos, "tp", 0) or 0),
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


def main():
    raw_cfg = sys.argv[1] if len(sys.argv) > 1 else "{}"
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

    candles_m5 = fetch_tf_candles(mt5, active_symbol, mt5.TIMEFRAME_M5, 60)
    candles = fetch_tf_candles(mt5, active_symbol, mt5.TIMEFRAME_M15, 60)
    candles_h1 = fetch_tf_candles(mt5, active_symbol, mt5.TIMEFRAME_H1, 60)
    candles_h4 = fetch_tf_candles(mt5, active_symbol, mt5.TIMEFRAME_H4, 60)

    live_analysis = analyze_live_candles(candles)
    tick_for_signal = mt5.symbol_info_tick(active_symbol)
    signal_bid = float(getattr(tick_for_signal, "bid", 0.0) or 0.0)
    signal_ask = float(getattr(tick_for_signal, "ask", 0.0) or 0.0)
    signal_mode = str(cfg.get("strategyMode") or "AUTO_REGIME")
    entry_signal = evaluate_entry(
        candles_m5, candles, candles_h1, candles_h4, signal_bid, signal_ask,
        signal_mode, cfg.get("minConfidence", 85)
    )
    raw_positions = mt5.positions_get() or []
    dca_settings = dict(cfg.get("positiveDcaConfig") or {})
    dca_settings["strategyMode"] = signal_mode
    dca_settings["minConfidence"] = cfg.get("minConfidence", 85)

    action_result = None
    trade_mode = int(getattr(account, "trade_mode", -1))
    is_demo_account = trade_mode == int(getattr(mt5, "ACCOUNT_TRADE_MODE_DEMO", 0))
    real_account = trade_mode == int(getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2))
    live_permission = (
        cfg.get("liveAuthorized") is True
        and os.environ.get("XAUUSD_V6_BROKER_LIVE_ATTESTED") == "I_ACKNOWLEDGE_RISK"
    )
    if action in ("order", "dca_plus", "manage_positions") and not (
        is_demo_account or (real_account and live_permission)
    ):
        action_result = {"ok": False, "message": "Broker mutation blocked: verified DEMO account required; REAL authorization not granted"}
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
        elif not manual and (
            len(candles) < 2 or time.time() * 1000 - int(candles[-2][4]) > 30 * 60 * 1000
        ):
            action_result = {"ok": False, "message": "Entry blocked: stale M15 candle"}
        else:
            sl_mode = str(cfg.get("slMode") or "STRUCTURAL_6_8").upper()
            if not manual:
                cfg["explicitSlPrice"] = entry_signal["sl"]
                cfg["explicitTpPrice"] = entry_signal["tp"]
                cfg["minRewardRisk"] = 1.25 if entry_signal.get("strategyMode") == "BOT_2_SIDEWAY" else 1.6
                cfg["entryReason"] = entry_signal["reason"]
                cfg["slReason"] = "Confirmed structural stop, never clipped inside swing"
                cfg["tpReason"] = "Per-strategy RR and H1/H4 or range target"
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
                        action_result = {"ok": False, "message": "Structural SL too wide or S/R gives insufficient R:R; order rejected"}
                    else:
                        cfg["slDistance"], cfg["explicitSlPrice"], cfg["slReason"], cfg["tpDistance"], cfg["explicitTpPrice"], cfg["tpReason"] = plan
            if action_result is None:
                cfg["side"] = request_side
                action_result = execute_order(mt5, active_symbol, cfg,
                                              comment_tag=("V6_" + str(entry_signal.get("strategyMode") or cfg.get("strategyMode") or "MANUAL"))[:31] if not manual else "V6_MANUAL")
            raw_positions = mt5.positions_get() or []


    elif action == "close":
        action_result = close_position_by_ticket(mt5, cfg.get("ticket"))
        raw_positions = mt5.positions_get() or []
    elif action == "breakeven":
        action_result = move_sl_to_breakeven(mt5, cfg.get("ticket"))
        raw_positions = mt5.positions_get() or []
    elif action == "dca_plus":
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
            "message": dca_res.get("reason", ""),
            "dcaStatus": dca_res,
        }
        raw_positions = mt5.positions_get() or []

    # Tự động quản lý lệnh theo cơ chế Bot Trend (SL 6-8 giá -> Đạt 1R kéo BE -> Trailing M5 -> Khóa đỉnh M15 cách 10 giá -> Chốt 1 phần tại cản H1/H4) cho cả lệnh Bot và lệnh vào tay (Bán tự động)
    trend_management_status = None
    if action == "manage_positions" and (is_demo_account or (real_account and live_permission)):
        trend_management_status = manage_trend_and_manual_positions(
            mt5,
            active_symbol,
            raw_positions,
            candles_m5,
            candles,
            candles_h1,
            candles_h4,
            None,
            cfg.get("trendManagementConfig") or {"useStructuralSl68": True, "enableM5StructuralTrail": True, "m15SpikeTrailDist": 10.0, "enablePartialCloseAtSr": True}
        )
        if action == "manage_positions":
            action_result = {"ok": True, "message": trend_management_status.get("summary", ""), "details": trend_management_status}
        raw_positions = mt5.positions_get() or []

    # Đánh giá trạng thái DCA Dương hiện tại
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

    open_positions = []
    for p in raw_positions:
        p_side = "BUY" if int(getattr(p, "type", 0)) == 0 else "SELL"
        p_open = round(float(getattr(p, "price_open", 0.0)), 2)
        p_cur = round(float(getattr(p, "price_current", 0.0)), 2)
        p_sl = round(float(getattr(p, "sl", 0.0)), 2)
        p_tp = round(float(getattr(p, "tp", 0.0)), 2)
        p_prof = round(float(getattr(p, "profit", 0.0)), 2)
        at_be_now = is_position_at_breakeven(p)
        if at_be_now:
            locked_pts = round((p_sl - p_open) if p_side == "BUY" else (p_open - p_sl), 2)
            hold_reason = f"Đã khóa SL dương (+{locked_pts} giá trên Entry), đang gồng theo cấu trúc M5 hướng tới TP vùng cản ({p_tp})"
        elif p_prof > 0:
            fav_pts = round((p_cur - p_open) if p_side == "BUY" else (p_open - p_cur), 2)
            hold_reason = f"Đang có lãi (+{fav_pts} giá / +${p_prof:.2f}), chờ đạt R:R 1:1 để tự động kéo SL về Hòa vốn (BE)"
        else:
            hold_reason = f"Đang trong vùng dao động cấu trúc, giữ SL bảo vệ tại {p_sl} và chờ sóng đẩy về TP {p_tp}"

        open_positions.append({
            "ticket": int(getattr(p, "ticket", 0)),
            "symbol": str(getattr(p, "symbol", "")),
            "side": p_side,
            "volume": round(float(getattr(p, "volume", 0.0)), 2),
            "entry": p_open,
            "openPrice": p_open,
            "current": p_cur,
            "currentPrice": p_cur,
            "sl": p_sl,
            "tp": p_tp,
            "profit": p_prof,
            "atBreakeven": at_be_now,
            "holdReason": hold_reason,
            "magic": int(getattr(p, "magic", 0)),
            "comment": str(getattr(p, "comment", "")),
        })

    recent_trades = []
    try:
        import datetime
        now_ts = time.time()
        # Cộng thêm +2 ngày (172800s) vào mốc kết thúc vì giờ Server MT5 (UTC+2/+3) luôn nhanh hơn giờ UTC!
        deals = mt5.history_deals_get(now_ts - 30 * 86400, now_ts + 2 * 86400) or []
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
            closed_at_str = datetime.datetime.fromtimestamp(deal_time_sec).strftime("%d/%m %H:%M:%S") if deal_time_sec > 0 else "Vừa đóng"
            net_pnl = (
                float(getattr(d, "profit", 0.0))
                + float(getattr(d, "commission", 0.0))
                + float(getattr(d, "swap", 0.0))
            )
            raw_comment = str(getattr(d, "comment", "") or "")
            if "tp" in raw_comment.lower():
                close_reason = f"Chạm Take Profit ({close_p})"
            elif "sl" in raw_comment.lower():
                close_reason = f"Chạm Stop Loss / BE ({close_p})" if abs(net_pnl) > 5 else f"Chạm Hòa vốn BE ({close_p})"
            elif "partial" in raw_comment.lower():
                close_reason = f"Chốt lời 50% tại vùng cản H1 ({close_p})"
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
        "liveAnalysis": live_analysis,
        "entrySignal": entry_signal,
        "mtfAnalysis": analyze_multi_timeframe_h4_h1_m15(candles_h4, candles_h1, candles, live_analysis, bid if bid > 0 else (candles[-1][3] if candles else 4678.96)),
        "candles": candles,
        "openPositions": open_positions,
        "recentTrades": recent_trades,
        "timestamp": int(time.time() * 1000),
    }
    mt5.shutdown()
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")

if __name__ == "__main__":
    main()
