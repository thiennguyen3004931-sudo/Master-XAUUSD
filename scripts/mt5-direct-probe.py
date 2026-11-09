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
    """
    Tính khoảng cách Stop Loss theo đáy/đỉnh cấu trúc gần nhất trên M5/M15,
    giới hạn chuẩn trong biên độ 6.0 đến 8.0 giá theo đề xuất của người dùng.
    """
    is_buy = str(side).upper() == "BUY"
    ref_candles = candles_m5[-10:] if (candles_m5 and len(candles_m5) >= 6) else (candles_m15[-6:] if candles_m15 else [])
    if ref_candles:
        if is_buy:
            swing_low = min(c[2] for c in ref_candles)
            raw_dist = (entry_price - swing_low) + 0.4
        else:
            swing_high = max(c[1] for c in ref_candles)
            raw_dist = (swing_high - entry_price) + 0.4
        clamped_dist = max(6.0, min(8.0, round(raw_dist, 2)))
    else:
        clamped_dist = 6.8
    return clamped_dist


def calc_structural_sl_and_sr_tp(candles_m5, candles_m15, candles_h1, candles_h4, side, entry_price, fallback_sl_dist=6.8, fallback_tp_dist=16.0):
    """
    Tính đồng thời:
    1. Stop Loss (SL) theo đáy/đỉnh cấu trúc M5/M15 trong biên 6.0 – 8.0 giá.
    2. Take Profit (TP) đặt trực tiếp tại vùng Kháng cự (cho BUY) hoặc Hỗ trợ (cho SELL) mạnh của khung lớn H1/H4.
    """
    is_buy = str(side).upper() == "BUY"
    sl_dist = calc_structural_sl_6_to_8(candles_m15, candles_m5, side, entry_price)
    sl_price = round(entry_price - sl_dist if is_buy else entry_price + sl_dist, 2)
    sl_reason = f"SL cấu trúc M5/M15 ({sl_dist:.2f} giá)"

    # Tìm các mốc Kháng cự (Đỉnh H1/H4) hoặc Hỗ trợ (Đáy H1/H4) thực tế
    min_tp_dist = max(10.0, round(sl_dist * 1.6, 2))
    tp_price = round(entry_price + fallback_tp_dist if is_buy else entry_price - fallback_tp_dist, 2)
    tp_reason = f"Vùng cản H1/H4 (+{fallback_tp_dist:.2f} giá)"

    h1_pool = candles_h1[-24:] if candles_h1 else []
    h4_pool = candles_h4[-24:] if candles_h4 else []

    if is_buy:
        sr_candidates = []
        if h1_pool:
            sr_candidates.extend([c[1] for c in h1_pool if c[1] >= entry_price + min_tp_dist])
        if h4_pool:
            sr_candidates.extend([c[1] for c in h4_pool if c[1] >= entry_price + min_tp_dist])
        if sr_candidates:
            # Chọn vùng kháng cự mạnh hợp lệ gần nhất (>= 1.6R) trừ lùi 0.25$ để dễ khớp lệnh trước tường cản
            target_sr = min(sr_candidates)
            tp_price = round(target_sr - 0.25, 2)
            tp_dist_actual = round(tp_price - entry_price, 2)
            tp_reason = f"Kháng cự mạnh H1/H4 tại {tp_price} (+{tp_dist_actual} giá)"
        else:
            # Nếu giá đang ở vùng đỉnh mới, lấy biên độ sóng H1/H4 chiếu lên (Fibonacci 1.618x SL cấu trúc)
            proj_dist = round(max(12.5, sl_dist * 2.2), 2)
            tp_price = round(entry_price + proj_dist, 2)
            tp_reason = f"Cản mở rộng H1/H4 2.2R tại {tp_price} (+{proj_dist} giá)"
    else:
        sr_candidates = []
        if h1_pool:
            sr_candidates.extend([c[2] for c in h1_pool if c[2] <= entry_price - min_tp_dist])
        if h4_pool:
            sr_candidates.extend([c[2] for c in h4_pool if c[2] <= entry_price - min_tp_dist])
        if sr_candidates:
            target_sr = max(sr_candidates)
            tp_price = round(target_sr + 0.25, 2)
            tp_dist_actual = round(entry_price - tp_price, 2)
            tp_reason = f"Hỗ trợ mạnh H1/H4 tại {tp_price} (-{tp_dist_actual} giá)"
        else:
            proj_dist = round(max(12.5, sl_dist * 2.2), 2)
            tp_price = round(entry_price - proj_dist, 2)
            tp_reason = f"Hỗ trợ mở rộng H1/H4 2.2R tại {tp_price} (-{proj_dist} giá)"

    tp_dist_final = round(abs(tp_price - entry_price), 2)
    return sl_dist, sl_price, sl_reason, tp_dist_final, tp_price, tp_reason

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

def modify_position_sl_tp(mt5, pos, new_sl, new_tp, reason_label=""):
    sym = str(pos.symbol)
    sym_info = mt5.symbol_info(sym)
    digits = int(getattr(sym_info, "digits", 2)) if sym_info else 2
    sl_val = round(float(new_sl), digits) if new_sl and new_sl > 0 else float(getattr(pos, "sl", 0.0) or 0.0)
    tp_val = round(float(new_tp), digits) if new_tp is not None else float(getattr(pos, "tp", 0.0) or 0.0)
    cur_sl = round(float(getattr(pos, "sl", 0.0) or 0.0), digits)
    cur_tp = round(float(getattr(pos, "tp", 0.0) or 0.0), digits)
    if abs(sl_val - cur_sl) < 0.02 and abs(tp_val - cur_tp) < 0.02:
        return {"ok": False, "changed": False, "message": "SL/TP không thay đổi."}

    req = {
        "action": int(getattr(mt5, "TRADE_ACTION_SLTP", 6)),
        "symbol": sym,
        "position": int(pos.ticket),
        "sl": sl_val,
        "tp": tp_val,
    }
    res = mt5.order_send(req)
    if res and int(getattr(res, "retcode", -1)) in (10009, 10025):
        return {
            "ok": True,
            "changed": True,
            "ticket": int(pos.ticket),
            "sl": sl_val,
            "tp": tp_val,
            "message": f"Lệnh #{pos.ticket}: {reason_label} (SL -> {sl_val}, TP -> {tp_val})"
        }
    return {"ok": False, "changed": False, "message": f"Chưa thể cập nhật SL/TP lệnh #{pos.ticket}."}

def manage_trend_and_manual_positions(mt5, active_symbol, pos_list, candles_m5, candles_m15, candles_h1, candles_h4, mtf_analysis, mgmt_cfg):
    """
    QUẢN LÝ LỆNH TOÀN DIỆN (CHO CẢ LỆNH BOT TREND, LỆNH DCA DƯƠNG & LỆNH NGƯỜI DÙNG VÀO TAY BÁN TỰ ĐỘNG):
    1. Tiếp quản lệnh vào tay (Semi-Auto Adoption): Nếu lệnh chưa có SL (sl == 0) và người dùng chọn chế độ
       tự đặt SL cấu trúc, tự động đặt SL theo cấu trúc 6–8 giá và TP tại vùng cản mạnh H4 (hoặc giữ SL/TP người dùng đã đặt).
    2. Khi lệnh đạt tỷ lệ R:R = 1:1 (lãi >= khoảng SL ban đầu, mặc định 6–8 giá): Tự động dời SL về Hòa vốn (BE ± 0.25 giá).
    3. Sau khi đã qua mốc 1R (đã kéo BE):
       - Dời SL từ từ lên theo cấu trúc Đáy/Đỉnh M5 (M5 Structural Trailing) để gồng trend xa nhất có thể.
       - Cơ chế chống giật cây M15 biến động mạnh (M15 Fast-Move Spike Protection): Nếu cây nến M15 hiện tại biến động mạnh
         (biên độ nến M15 >= 5.5 giá hoặc lệnh đang lãi sâu >= 12 giá), tự động dời SL bám sát cách ĐỈNH CAO NHẤT (High Peak)
         đúng 10.0 giá (BUY) hoặc cách ĐÁY THẤP NHẤT (Low Peak) đúng 10.0 giá (SELL) nếu tốt hơn SL hiện tại!
    4. Tại vùng Kháng cự / Hỗ trợ mạnh của khung lớn (H1/H4):
       - Khi giá chạm vùng cản mạnh H1 và lệnh đang có lãi > 1R, tự động chốt một phần (50% khối lượng) nếu khối lượng >= 0.02 lot,
         và mở rộng/dời TP của phần còn lại lên vùng Kháng cự / Hỗ trợ mới của khung H4 để gồng tối đa sóng!
    """
    sym_positions = [p for p in pos_list if str(getattr(p, "symbol", "")) == active_symbol]
    if not sym_positions:
        return {"managedCount": 0, "actions": [], "summary": "Chưa có vị thế đang mở để quản lý."}

    actions = []
    spike_trail_dist = float(mgmt_cfg.get("m15SpikeTrailDist") or 10.0)
    use_structural_sl = bool(mgmt_cfg.get("useStructuralSl68", True))
    enable_m5_trail = bool(mgmt_cfg.get("enableM5StructuralTrail", True))
    enable_partial_sr = bool(mgmt_cfg.get("enablePartialCloseAtSr", True))

    # Lấy mốc cản H1 và H4 từ mtf_analysis
    h1_high = max((c[1] for c in candles_h1[-12:]), default=0.0) if candles_h1 else 0.0
    h1_low = min((c[2] for c in candles_h1[-12:]), default=0.0) if candles_h1 else 0.0
    h4_high = max((c[1] for c in candles_h4[-16:]), default=0.0) if candles_h4 else 0.0
    h4_low = min((c[2] for c in candles_h4[-16:]), default=0.0) if candles_h4 else 0.0

    cur_m15_range = abs(candles_m15[-1][1] - candles_m15[-1][2]) if candles_m15 else 0.0
    cur_m15_high = candles_m15[-1][1] if candles_m15 else 0.0
    cur_m15_low = candles_m15[-1][2] if candles_m15 else 0.0

    for p in sym_positions:
        is_buy = int(getattr(p, "type", 0)) == 0
        side = "BUY" if is_buy else "SELL"
        open_p = float(getattr(p, "price_open", 0.0))
        cur_p = float(getattr(p, "price_current", 0.0))
        cur_sl = float(getattr(p, "sl", 0.0) or 0.0)
        cur_tp = float(getattr(p, "tp", 0.0) or 0.0)
        favorable = (cur_p - open_p) if is_buy else (open_p - cur_p)

        # 1. Nếu là lệnh vào tay chưa đặt SL (cur_sl <= 0) và bật chế độ Bán tự động / Cấu trúc 6-8 giá
        if cur_sl <= 0 and use_structural_sl:
            sl_dist = calc_structural_sl_6_to_8(candles_m15, candles_m5, side, open_p)
            init_sl = round(open_p - sl_dist if is_buy else open_p + sl_dist, 2)
            init_tp = cur_tp
            if init_tp <= 0 and h4_high > 0 and h4_low > 0:
                init_tp = round(max(open_p + sl_dist * 2.2, h4_high) if is_buy else min(open_p - sl_dist * 2.2, h4_low), 2)
            mod_res = modify_position_sl_tp(mt5, p, init_sl, init_tp, f"Tự động bảo vệ lệnh vào tay bằng SL cấu trúc {sl_dist} giá")
            if mod_res.get("changed"):
                actions.append(mod_res["message"])
                cur_sl = init_sl
                cur_tp = init_tp

        # Tính khoảng rủi ro 1R của lệnh (nếu SL đã kéo lên trên Entry thì 1R mặc định tính theo biên cấu trúc 6.5 giá)
        if cur_sl > 0:
            raw_risk = (open_p - cur_sl) if is_buy else (cur_sl - open_p)
            one_r_dist = raw_risk if (4.0 <= raw_risk <= 12.0) else 6.5
        else:
            one_r_dist = 6.5

        at_be = is_position_at_breakeven(p)

        # 2. Khi đạt R:R = 1:1 (favorable >= one_r_dist) -> Kéo SL về Hòa vốn (BE ± 0.25 giá)
        if not at_be and favorable >= one_r_dist:
            be_price = round(open_p + (0.25 if is_buy else -0.25), 2)
            mod_be = modify_position_sl_tp(mt5, p, be_price, cur_tp, f"Đạt R:R 1:1 (+{favorable:.2f} giá) → Tự động kéo SL về Hòa vốn (BE)")
            if mod_be.get("changed"):
                actions.append(mod_be["message"])
                cur_sl = be_price
                at_be = True

        # 3. Sau khi đã kéo BE: Nâng dần SL theo cấu trúc M5 + Cơ chế khóa cách đỉnh 10 giá khi cây M15 biến động mạnh
        if at_be:
            best_new_sl = cur_sl
            trail_reason = ""

            # (a) Nâng SL từ từ theo đáy/đỉnh cấu trúc M5
            if enable_m5_trail:
                m5_sl = find_m5_structural_trail_sl(candles_m5, side, cur_p, open_p)
                if m5_sl is not None:
                    if (is_buy and m5_sl > best_new_sl + 0.15) or (not is_buy and (best_new_sl <= 0 or m5_sl < best_new_sl - 0.15)):
                        best_new_sl = m5_sl
                        trail_reason = f"Nâng SL từ từ theo cấu trúc M5 ({m5_sl})"

            # (b) Cơ chế cây M15 biến động mạnh: Dời SL cách 10 giá tính từ giá Đỉnh/Đáy cao nhất của đợt sóng
            peak_high = max(cur_p, cur_m15_high, max((c[1] for c in candles_m15[-3:]), default=cur_p)) if candles_m15 else cur_p
            peak_low = min(cur_p, cur_m15_low, min((c[2] for c in candles_m15[-3:]), default=cur_p)) if candles_m15 else cur_p
            peak_excursion = (peak_high - open_p) if is_buy else (open_p - peak_low)

            if cur_m15_range >= 5.5 or peak_excursion >= (one_r_dist + spike_trail_dist):
                spike_sl = round((peak_high - spike_trail_dist) if is_buy else (peak_low + spike_trail_dist), 2)
                if is_buy and spike_sl > open_p + 0.25 and spike_sl > best_new_sl + 0.15 and spike_sl < cur_p - 0.8:
                    best_new_sl = spike_sl
                    trail_reason = f"Biến động mạnh M15 (Đỉnh {peak_high:.2f}) → Khóa SL cách đỉnh {spike_trail_dist} giá ({spike_sl})"
                elif not is_buy and spike_sl < open_p - 0.25 and (best_new_sl <= 0 or spike_sl < best_new_sl - 0.15) and spike_sl > cur_p + 0.8:
                    best_new_sl = spike_sl
                    trail_reason = f"Biến động mạnh M15 (Đáy {peak_low:.2f}) → Khóa SL cách đáy {spike_trail_dist} giá ({spike_sl})"

            if trail_reason and abs(best_new_sl - cur_sl) >= 0.15:
                mod_tr = modify_position_sl_tp(mt5, p, best_new_sl, cur_tp, trail_reason)
                if mod_tr.get("changed"):
                    actions.append(mod_tr["message"])
                    cur_sl = best_new_sl

            # 4. Tại vùng Kháng cự / Hỗ trợ mạnh của khung lớn (H1/H4): Chốt một phần và dời TP tới cản khung lớn mới
            if enable_partial_sr and favorable >= one_r_dist * 1.2:
                near_h1_sr = (is_buy and h1_high > 0 and cur_p >= h1_high - 1.5) or (not is_buy and h1_low > 0 and cur_p <= h1_low + 1.5)
                if near_h1_sr and float(getattr(p, "volume", 0.0)) >= 0.02:
                    p_res = partial_close_position(mt5, p, close_ratio=0.5)
                    if p_res.get("ok"):
                        actions.append(p_res["message"])
                        # Mở rộng TP phần còn lại lên vùng cản H4 mới xa hơn
                        new_h4_tp = round(max(h4_high, cur_p + 12.0) if is_buy else min(h4_low, cur_p - 12.0), 2)
                        if abs(new_h4_tp - cur_tp) > 1.0:
                            modify_position_sl_tp(mt5, p, cur_sl, new_h4_tp, "Nâng TP phần gồng còn lại tới vùng cản H4 mới")

    return {
        "managedCount": len(sym_positions),
        "actions": actions,
        "summary": " | ".join(actions) if actions else f"Đang quản lý {len(sym_positions)} lệnh theo quy tắc: SL 6–8 giá → Đạt 1R kéo BE → Trailing cấu trúc M5 & Khóa đỉnh M15 cách {spike_trail_dist} giá."
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
    volume = max(vol_min, volume)

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

def check_bot_signal_for_mode(live_analysis, strategy_mode, required_side, min_conf=80):
    """
    Kiểm tra xem tín hiệu nến hiện tại có thỏa mãn ĐIỀU KIỆN CỦA LOẠI BOT đang chọn hay không.
    """
    if not live_analysis:
        return False, "Chưa có dữ liệu phân tích nến M15/M5."
    sig_side = str(live_analysis.get("signalSide") or "WAIT").upper()
    conf = float(live_analysis.get("confidence") or 0)
    pname = str(live_analysis.get("patternName") or "")
    trend_aligned = bool(live_analysis.get("trendAligned", False))

    if sig_side != required_side:
        return False, f"Tín hiệu Bot hiện tại ({sig_side} - {pname}) chưa đồng thuận với chiều lệnh đang mở ({required_side})."

    mode = str(strategy_mode or "AUTO_REGIME").upper()
    if mode == "BOT_1_TREND":
        is_trend_pat = ("Engulfing" in pname) or ("Xu hướng" in pname) or ("Continuation" in pname) or ("Flag" in pname)
        if not (is_trend_pat and trend_aligned and conf >= min_conf):
            return False, f"Bot 1 (Trend Rider) đang chờ nhịp hồi Pullback EMA/FVG & nến xác nhận (Hiện tại: {pname}, Tin cậy {conf:.0f}%)."
        return True, f"Thỏa điều kiện Bot 1 (Trend Rider): {pname} thuận xu hướng ({conf:.0f}%)."

    if mode in ("BOT_3_SWEEP", "BOT_4_SWEEP_DCA_PLUS"):
        is_sweep_pat = ("Sweep" in pname) or ("Pinbar" in pname) or ("Upthrust" in pname) or ("Engulfing" in pname)
        if not (is_sweep_pat and conf >= min_conf):
            return False, f"Bot Sweep đang chờ mẫu nến Quét thanh khoản Pinbar/Engulfing (Hiện tại: {pname}, Tin cậy {conf:.0f}%)."
        return True, f"Thỏa điều kiện Bot Liquidity Sweep: {pname} ({conf:.0f}%)."

    if mode == "BOT_2_SIDEWAY":
        return False, "Bot 2 (Sideway Corridor) chuyên đánh biên đi ngang — tự động khóa nhồi lệnh DCA Dương để tránh mua đỉnh/bán đáy hộp."

    # AUTO_REGIME (Tự động chọn theo cấu trúc thị trường)
    if not (trend_aligned and conf >= min_conf):
        return False, f"Chế độ Tự động (Auto-Regime) đang chờ tín hiệu nến đạt độ tin cậy >= {min_conf}% (Hiện tại: {pname} - {conf:.0f}%)."
    return True, f"Thỏa điều kiện Bot Tự động ({pname} - Tin cậy {conf:.0f}%)."


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


def evaluate_and_execute_positive_dca(mt5, active_symbol, pos_list, live_analysis, dca_cfg, force_manual=False):
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
        if favorable_dist >= be_trigger_dist or force_manual:
            for old_p in sym_positions:
                if not is_position_at_breakeven(old_p):
                    move_sl_to_breakeven(mt5, int(getattr(old_p, "ticket", 0)))
            all_at_be = True
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

    if not bot_ok and not force_manual:
        return {
            "eligible": False,
            "executed": False,
            "currentLayers": current_dca_layers,
            "reason": f"Lệnh đầu đã kéo BE & đang dương, đang chờ tín hiệu chuẩn của Bot: {bot_reason}"
        }

    # Tránh nhồi trùng 2 lệnh tại cùng một mức giá (yêu cầu cách lệnh trước tối thiểu 1.2 giá)
    if favorable_dist < 1.2 and not force_manual:
        return {
            "eligible": False,
            "executed": False,
            "currentLayers": current_dca_layers,
            "reason": f"Đã có tín hiệu Bot ({bot_reason}) nhưng giá hiện tại ({cur_price}) còn quá sát lệnh vừa mở ({last_entry})."
        }

    if not dca_cfg.get("enabled", False) and not force_manual:
        return {
            "eligible": True,
            "executed": False,
            "currentLayers": current_dca_layers,
            "reason": f"ĐỦ ĐIỀU KIỆN DCA DƯƠNG TẦNG #{current_dca_layers + 1} (Lệnh đầu đã kéo BE + {bot_reason}), nhưng công tắc DCA Dương đang TẮT."
        }

    # Đảm bảo toàn bộ lệnh cũ đã khóa SL về BE trước khi gửi lệnh DCA Dương
    for old_p in sym_positions:
        move_sl_to_breakeven(mt5, int(getattr(old_p, "ticket", 0)))

    base_vol = float(getattr(base_pos, "volume", 0.02))
    mult = float(dca_cfg.get("lotMultiplier") or 0.5)
    next_layer_num = current_dca_layers + 1
    dca_vol = max(0.01, round(base_vol * (mult ** next_layer_num), 2))

    # Đặt SL và TP của lệnh DCA Dương theo đúng quy tắc lệnh đầu của Bot (SL cấu trúc 6–8 giá hoặc theo lệnh đầu)
    base_open = float(getattr(base_pos, "price_open", cur_price))
    base_tp = float(getattr(base_pos, "tp", 0.0) or 0.0)
    dca_sl_dist = float(dca_cfg.get("slDistance") or 6.8)
    if dca_cfg.get("useStructuralSl68", True):
        dca_sl_dist = max(6.0, min(8.0, dca_sl_dist))
    dca_tp_dist = float(dca_cfg.get("tpDistance") or 14.0)
    if base_tp > 0:
        rem_tp_dist = (base_tp - cur_price) if side == "BUY" else (cur_price - base_tp)
        if rem_tp_dist >= 4.0:
            dca_tp_dist = round(rem_tp_dist, 2)

    order_res = execute_order(
        mt5,
        active_symbol,
        {
            "side": side,
            "volume": dca_vol,
            "slDistance": dca_sl_dist,
            "tpDistance": dca_tp_dist,
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
    positions = mt5.positions_get(ticket=int(ticket_id)) if ticket_id else mt5.positions_get()
    if not positions:
        return {"ok": False, "message": "Không tìm thấy vị thế đang mở để dời SL Hòa vốn."}

    pos = positions[0]
    sym = str(pos.symbol)
    sym_info = mt5.symbol_info(sym)
    digits = int(getattr(sym_info, "digits", 2)) if sym_info else 2
    is_buy = int(pos.type) == 0
    be_price = round(float(pos.price_open) + (0.25 if is_buy else -0.25), digits)

    req = {
        "action": int(getattr(mt5, "TRADE_ACTION_SLTP", 6)),
        "symbol": sym,
        "position": int(pos.ticket),
        "sl": be_price,
        "tp": float(pos.tp),
    }
    res = mt5.order_send(req)
    if res and int(getattr(res, "retcode", -1)) in (10009, 10025):
        return {"ok": True, "message": f"Đã dời SL lệnh #{pos.ticket} về Hòa vốn ({be_price}) thành công!"}
    return {"ok": False, "message": f"Chưa thể dời SL về BE: {getattr(res, 'comment', '')}"}

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

    candles_m5 = fetch_tf_candles(mt5, active_symbol, mt5.TIMEFRAME_M5, 30)
    candles = fetch_tf_candles(mt5, active_symbol, mt5.TIMEFRAME_M15, 24)
    candles_h1 = fetch_tf_candles(mt5, active_symbol, mt5.TIMEFRAME_H1, 40)
    candles_h4 = fetch_tf_candles(mt5, active_symbol, mt5.TIMEFRAME_H4, 40)

    live_analysis = analyze_live_candles(candles)
    raw_positions = mt5.positions_get() or []

    action_result = None
    if action == "order":
        sl_mode = str(cfg.get("slMode") or ("FIXED_CUSTOM" if cfg.get("forceFixedSlTp") else "STRUCTURAL_6_8")).upper()
        if sl_mode != "FIXED_CUSTOM":
            tick_now = mt5.symbol_info_tick(active_symbol)
            side_req = str(cfg.get("side", "BUY")).upper()
            entry_est = float(tick_now.ask if side_req == "BUY" else tick_now.bid) if tick_now else 4678.96
            sl_d, sl_p, sl_rsn, tp_d, tp_p, tp_rsn = calc_structural_sl_and_sr_tp(
                candles_m5, candles, candles_h1, candles_h4, side_req, entry_est,
                float(cfg.get("slDistance") or 6.8), float(cfg.get("tpDistance") or 16.0)
            )
            cfg["slDistance"] = sl_d
            cfg["tpDistance"] = tp_d
            cfg["explicitSlPrice"] = sl_p
            cfg["explicitTpPrice"] = tp_p
            cfg["slReason"] = sl_rsn
            cfg["tpReason"] = tp_rsn
        else:
            cfg["slReason"] = f"SL cố định ({cfg.get('slDistance', 6.8)} giá)"
            cfg["tpReason"] = f"TP cố định ({cfg.get('tpDistance', 16.0)} giá)"
        if not cfg.get("entryReason") and live_analysis:
            cfg["entryReason"] = f"{live_analysis.get('patternName', 'Tín hiệu M15')} — {live_analysis.get('reason', '')} (Tin cậy {live_analysis.get('confidence', 86)}%)"
        action_result = execute_order(mt5, active_symbol, cfg)
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
            live_analysis,
            cfg.get("positiveDcaConfig") or {"enabled": True, "maxLayers": 2, "stepDistance": 4.5, "lotMultiplier": 0.5},
            force_manual=bool(cfg.get("forceManual", False))
        )
        action_result = {
            "ok": bool(dca_res.get("executed")),
            "message": dca_res.get("reason", ""),
            "dcaStatus": dca_res,
        }
        raw_positions = mt5.positions_get() or []

    # Tự động quản lý lệnh theo cơ chế Bot Trend (SL 6-8 giá -> Đạt 1R kéo BE -> Trailing M5 -> Khóa đỉnh M15 cách 10 giá -> Chốt 1 phần tại cản H1/H4) cho cả lệnh Bot và lệnh vào tay (Bán tự động)
    trend_management_status = None
    if cfg.get("autoManageBe", True) or action == "manage_positions":
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
        live_analysis,
        cfg.get("positiveDcaConfig") or {"enabled": False, "maxLayers": 2, "stepDistance": 4.5, "lotMultiplier": 0.5},
        force_manual=False
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
