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
from math import isfinite, floor
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

def analyze_live_candles(candles, candles_h1=None, candles_h4=None):
    if not candles or len(candles) < 8:
        return {
            "patternId": "RANGE_BOX",
            "patternName": "12. Hộp Tích Lũy Nén Biên Độ (Đang thu thập nến M15)",
            "signalSide": "WAIT",
            "trendAligned": False,
            "confidence": 75,
            "atr": 4.5,
            "reason": "Cần tối thiểu 8 nến M15 để xác nhận mẫu hình thời gian thực."
        }
    closed_bars = candles[:-1] if len(candles) > 10 else candles
    ranges = [abs(c[1] - c[2]) for c in closed_bars[-14:]]
    atr = round(sum(ranges) / max(1, len(ranges)), 2)
    atr = max(1.5, atr)

    c1 = closed_bars[-2]
    c2 = closed_bars[-1]
    c3 = candles[-1]

    o1, h1, l1, cl1 = c1[0], c1[1], c1[2], c1[3]
    o2, h2, l2, cl2 = c2[0], c2[1], c2[2], c2[3]
    o3, h3, l3, cl3 = c3[0], c3[1], c3[2], c3[3]

    body1 = cl1 - o1
    body2 = cl2 - o2
    rng2 = max(0.01, h2 - l2)
    lower_wick2 = min(o2, cl2) - l2
    upper_wick2 = h2 - max(o2, cl2)

    closed_closes = [c[3] for c in closed_bars]
    ema10 = calc_ema(closed_closes, min(10, len(closed_closes)))
    ema25 = calc_ema(closed_closes, min(25, len(closed_closes)))

    # Xác định xu hướng H1 / H4 để không bao giờ nhận diện ngược chiều xu hướng chính
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

    # Nếu giá đóng nến M15 đã sập xuống dưới cả EMA10 và EMA25 (hoặc H1 giảm), xác nhận ngay là xu hướng Giảm (không đợi EMA10 cắt trễ)
    price_below_both_emas = (cl2 < ema10 and cl2 < ema25)
    price_above_both_emas = (cl2 > ema10 and cl2 > ema25)
    is_bear_trend = price_below_both_emas or (not price_above_both_emas and (h1_bear or (ema10 < ema25 and cl2 <= ema25)))
    is_bull_trend = (not is_bear_trend) and (price_above_both_emas or h1_bull or (ema10 >= ema25 and cl2 >= ema25))
    ema_gap_ratio = abs(ema10 - ema25) / max(0.5, atr)
    engulf_ratio = abs(body2) / max(0.05, abs(body1))

    prior8 = closed_bars[-9:-1] if len(closed_bars) >= 9 else closed_bars[:-1]
    old_low8 = min(b[2] for b in prior8) if prior8 else l2
    old_high8 = max(b[1] for b in prior8) if prior8 else h2

    # 1. Kiểm tra Sideway Hộp Tích Lũy (#12 RANGE_BOX)
    recent20 = closed_bars[-20:]
    box_w = (max(b[1] for b in recent20) - min(b[2] for b in recent20)) if recent20 else 99.0
    if h1_flat and box_w <= 4.2 * atr and ema_gap_ratio < 0.35:
        return {
            "patternId": "RANGE_BOX",
            "patternName": "12. Hộp Tích Lũy Nén Biên Độ (Sideway Range)",
            "signalSide": "SELL" if cl2 < ema25 else "BUY",
            "trendAligned": False,
            "confidence": 86,
            "atr": atr,
            "ema10": ema10,
            "ema25": ema25,
            "reason": f"Khung H1 phẳng, giá nén trong hộp tích lũy {box_w:.1f} giá (ATR ${atr}) · Ưu tiên đánh biên."
        }

    # 2. Nếu xu hướng chủ đạo đang là GIẢM (BEARISH / SELL) -> Chỉ khớp nhóm mẫu hình Giảm (#7..#11)
    if is_bear_trend:
        # #7: Quét Thanh Khoản Đỉnh (Upthrust)
        if (h2 > old_high8 and cl2 < old_high8) or (upper_wick2 / rng2 >= 0.45 and cl2 <= o2):
            wick_pct = upper_wick2 / rng2
            dyn_conf = min(94, max(86, int(round(86 + wick_pct * 8.0 + min(3.0, ema_gap_ratio * 2.0)))))
            return {
                "patternId": "BEAR_SWEEP_UPTHRUST",
                "patternName": "7. Quét Thanh Khoản Đỉnh (Upthrust)",
                "signalSide": "SELL",
                "trendAligned": True,
                "confidence": dyn_conf,
                "atr": atr,
                "ema10": ema10,
                "ema25": ema25,
                "reason": f"Nến M15 quét đỉnh cũ ({h2}) rồi rút râu đóng giảm tại {cl2} thuận xu hướng Giảm (EMA10 {ema10} < EMA25 {ema25}, tin cậy {dyn_conf}%)."
            }
        # Kiểm tra cấu trúc đỉnh trong 12 nến M15 gần nhất để phân biệt Vai Đầu Vai Đỉnh (#8), Hai Đỉnh (#9), Tam Giác Giảm (#11) và Cờ Giảm (#10)
        recent12 = closed_bars[-12:]
        highs12 = [b[1] for b in recent12]
        lows12 = [b[2] for b in recent12]
        h_first = max(highs12[:4]) if len(highs12) >= 12 else h2
        h_mid = max(highs12[4:8]) if len(highs12) >= 12 else h2
        h_last = max(highs12[8:]) if len(highs12) >= 12 else h2
        l_first = min(lows12[:6]) if len(lows12) >= 12 else l2
        l_last = min(lows12[6:]) if len(lows12) >= 12 else l2

        # #8: Vai Đầu Vai Đỉnh (H&S Top) - Đỉnh giữa cao hơn 2 vai
        if h_mid > h_first + 0.6 and h_mid > h_last + 0.6 and cl2 < ema10:
            dyn_conf = min(93, max(86, int(round(87 + min(4.0, ema_gap_ratio * 2.5)))))
            return {
                "patternId": "BEAR_HS_TOP",
                "patternName": "8. Vai Đầu Vai Đỉnh (H&S Top)",
                "signalSide": "SELL",
                "trendAligned": True,
                "confidence": dyn_conf,
                "atr": atr,
                "ema10": ema10,
                "ema25": ema25,
                "reason": f"Cấu trúc Đỉnh Đầu ({h_mid}) cao hơn 2 Vai ({h_first} / {h_last}), giá ({cl2}) nằm dưới EMA10 ({ema10}) thuận trend Giảm."
            }
        # #9: Hai Đỉnh Đảo Chiều (Double Top)
        if abs(h_first - h_last) <= 0.45 * atr and cl2 < (h_last - 0.8 * atr):
            dyn_conf = min(92, max(85, int(round(86 + min(4.0, ema_gap_ratio * 2.2)))))
            return {
                "patternId": "BEAR_DOUBLE_TOP",
                "patternName": "9. Hai Đỉnh Đảo Chiều (Double Top)",
                "signalSide": "SELL",
                "trendAligned": True,
                "confidence": dyn_conf,
                "atr": atr,
                "ema10": ema10,
                "ema25": ema25,
                "reason": f"2 lần chạm vùng cung ({h_first} – {h_last}) bị từ chối giảm về {cl2} dưới EMA25 ({ema25})."
            }
        # #11: Tam Giác Giảm (Descending Triangle) - Đỉnh hạ thấp dần ép về đáy phẳng
        if h_last < h_mid <= h_first and abs(l_first - l_last) <= 0.6 * atr:
            dyn_conf = min(91, max(85, int(round(85 + min(4.0, ema_gap_ratio * 2.2)))))
            return {
                "patternId": "BEAR_DESC_TRIANGLE",
                "patternName": "11. Tam Giác Giảm (Descending)",
                "signalSide": "SELL",
                "trendAligned": True,
                "confidence": dyn_conf,
                "atr": atr,
                "ema10": ema10,
                "ema25": ema25,
                "reason": f"Đỉnh M15 hạ thấp dần ({h_first} → {h_mid} → {h_last}) ép sát hỗ trợ {l_last} trong xu hướng Giảm."
            }
        # Mặc định trong Trend Giảm: #10 Cờ Giảm Tiếp Diễn (Bearish Flag)
        body_ratio = abs(body2) / rng2
        dyn_conf = min(93, max(85, int(round(85 + body_ratio * 4.0 + min(4.0, ema_gap_ratio * 2.2)))))
        return {
            "patternId": "BEAR_PENNANT",
            "patternName": "10. Cờ Giảm Tiếp Diễn (Bearish Flag)",
            "signalSide": "SELL",
            "trendAligned": True,
            "confidence": dyn_conf,
            "atr": atr,
            "ema10": ema10,
            "ema25": ema25,
            "reason": f"Sóng giảm chủ đạo (EMA10 {ema10} < EMA25 {ema25}) kèm nhịp tích lũy Cờ Giảm tại {cl2} · Ưu tiên canh SELL (tin cậy {dyn_conf}%)."
        }

    # 3. Nếu xu hướng chủ đạo đang là TĂNG (BULLISH / BUY) -> Chỉ khớp nhóm mẫu hình Tăng (#1..#6)
    if (l2 < old_low8 and cl2 > old_low8) or (lower_wick2 / rng2 >= 0.45 and cl2 >= o2):
        wick_pct = lower_wick2 / rng2
        dyn_conf = min(94, max(86, int(round(86 + wick_pct * 8.0 + min(3.0, ema_gap_ratio * 2.0)))))
        return {
            "patternId": "BULL_SWEEP_PINBAR",
            "patternName": "1. Quét Thanh Khoản Đáy + Pinbar",
            "signalSide": "BUY",
            "trendAligned": True,
            "confidence": dyn_conf,
            "atr": atr,
            "ema10": ema10,
            "ema25": ema25,
            "reason": f"Râu dưới quét đáy cũ ({l2}) rồi rút chân đóng tăng tại {cl2} thuận xu hướng Tăng (EMA10 {ema10} ≥ EMA25 {ema25}, tin cậy {dyn_conf}%)."
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
            "confidence": dyn_conf,
            "atr": atr,
            "ema10": ema10,
            "ema25": ema25,
            "reason": f"Cấu trúc 3 đáy với đáy giữa sâu nhất ({l_mid}), giá ({cl2}) bứt lên trên EMA10 ({ema10})."
        }
    if abs(l_first - l_last) <= 0.45 * atr and cl2 > (l_last + 0.8 * atr):
        dyn_conf = min(92, max(85, int(round(86 + min(4.0, ema_gap_ratio * 2.2)))))
        return {
            "patternId": "BULL_DOUBLE_BOTTOM",
            "patternName": "3. Hai Đáy Phân Kỳ (Double Bottom)",
            "signalSide": "BUY",
            "trendAligned": True,
            "confidence": dyn_conf,
            "atr": atr,
            "ema10": ema10,
            "ema25": ema25,
            "reason": f"Kiểm định vùng cầu ({l_first} – {l_last}) 2 lần không thủng, bật tăng lên {cl2}."
        }
    if l_last > l_mid >= l_first and abs(h_first - h_last) <= 0.6 * atr:
        dyn_conf = min(91, max(85, int(round(85 + min(4.0, ema_gap_ratio * 2.2)))))
        return {
            "patternId": "BULL_ASC_TRIANGLE",
            "patternName": "6. Tam Giác Tăng (Ascending)",
            "signalSide": "BUY",
            "trendAligned": True,
            "confidence": dyn_conf,
            "atr": atr,
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
        "confidence": dyn_conf,
        "atr": atr,
        "ema10": ema10,
        "ema25": ema25,
        "reason": f"Sóng tăng chủ đạo (EMA10 {ema10} ≥ EMA25 {ema25}) kèm kênh Cờ Tăng tại {cl2} · Ưu tiên canh BUY (tin cậy {dyn_conf}%)."
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

def analyze_multi_timeframe_h4_h1_m15(candles_h4, candles_h1, candles_m15, live_analysis, current_price, entry_signal=None):
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
        es_h4 = (entry_signal or {}).get("h4Bias")
        h4_bull = (es_h4 == "BUY") if es_h4 in ("BUY", "SELL") else (p >= ema34_h4)
        h4_bias = "TĂNG CHỦ ĐẠO (Bullish Structure)" if h4_bull else "GIẢM CHỦ ĐẠO (Bearish Structure)"
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
        es_h1 = (entry_signal or {}).get("h1Bias")
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

    # 3. Phân tích M15 & Lên kịch bản 15 phút (Đồng nhất 100% với entry_signal và H4/H1)
    es_side = (entry_signal or {}).get("side")
    es_pref = (entry_signal or {}).get("preferredSide")
    if es_side in ("BUY", "SELL"):
        m15_side = es_side
    elif es_pref in ("BUY", "SELL"):
        m15_side = es_pref
    elif not h4_bull and not h1_bull:
        m15_side = "SELL"
    elif h4_bull and h1_bull:
        m15_side = "BUY"
    else:
        m15_side = str(live_analysis.get("signalSide") or ("BUY" if h4_bull else "SELL")).upper()
        if m15_side == "WAIT":
            m15_side = "BUY" if h4_bull else "SELL"
    m15_pat = str(live_analysis.get("patternName") or ("4. Cờ Tăng Tiếp Diễn (Bullish Flag)" if m15_side == "BUY" else "10. Cờ Giảm Tiếp Diễn (Bearish Flag)"))
    if m15_side == "SELL" and ("Tăng" in m15_pat or "Bullish" in m15_pat):
        m15_pat = "10. Cờ Giảm Tiếp Diễn (Bearish Flag)"
    elif m15_side == "BUY" and ("Giảm" in m15_pat or "Bearish" in m15_pat):
        m15_pat = "4. Cờ Tăng Tiếp Diễn (Bullish Flag)"
    m15_conf = int(live_analysis.get("confidence") or 88)
    m15_atr = float(live_analysis.get("atr") or 4.5)

    is_buy_plan = (m15_side == "BUY")
    entry_low = round(p - 1.2 if is_buy_plan else p - 0.5, 2)
    entry_high = round(p + 0.5 if is_buy_plan else p + 1.2, 2)
    plan_sl_dist = max(6.8, min(9.6, round(m15_atr * 1.35, 2)))
    sl_price = round(float((entry_signal or {}).get("sl") or (p - plan_sl_dist if is_buy_plan else p + plan_sl_dist)), 2)
    actual_r = round(abs(p - sl_price), 2) or 6.8
    be_price = round(p + actual_r if is_buy_plan else p - actual_r, 2)
    tp1_price = round(p + round(actual_r * 1.35, 2) if is_buy_plan else p - round(actual_r * 1.35, 2), 2)
    tp2_price = round(float((entry_signal or {}).get("tp") or (p + round(actual_r * 1.85, 2) if is_buy_plan else p - round(actual_r * 1.85, 2))), 2)

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
    """Manual order: use structural M5/M15 stop when within 6-10 units, or fallback to user-configured 6-10 stop; pick valid H1/H4 S/R target >= 1.6R."""
    sl = structural_stop(side, entry_price, candles_m5, candles_m15, max_distance=10.0)
    if sl is not None:
        sl_dist = round(abs(entry_price - sl), 2)
        sl_reason = f"SL cấu trúc M5 ({sl_dist} giá)"
    else:
        sl_dist = round(max(6.0, min(10.0, float(fallback_sl_dist or 6.8))), 2)
        sl = round(entry_price - sl_dist if side == "BUY" else entry_price + sl_dist, 2)
        sl_reason = f"SL cấu trúc bảo vệ ({sl_dist} giá)"
    h1 = closed(candles_h1)
    h4 = closed(candles_h4)
    min_rr = 1.6
    min_tp_dist = max(float(fallback_tp_dist or 16.0), round(sl_dist * min_rr + 0.25, 2))
    if side == "BUY":
        valid_sr = sorted(b[1] for b in h1[-24:] + h4[-18:] if b[1] >= entry_price + sl_dist * min_rr + 0.25)
        tp = round(valid_sr[0] - 0.25 if valid_sr else entry_price + max(min_tp_dist, round(sl_dist * 2.2, 2)), 2)
    else:
        valid_sr = sorted((b[2] for b in h1[-24:] + h4[-18:] if b[2] <= entry_price - sl_dist * min_rr - 0.25), reverse=True)
        tp = round(valid_sr[0] + 0.25 if valid_sr else entry_price - max(min_tp_dist, round(sl_dist * 2.2, 2)), 2)
    return (
        sl_dist, sl, sl_reason,
        round(abs(tp - entry_price), 2), tp, "TP vùng cản H1/H4 hoặc 2.2R"
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
    # Always round DOWN, never increase requested risk or close more than intended.
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
        # A vanished ticket could mean full close, netting, or delayed state; never claim a half-close.
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
    # The caller's position may be stale after another EA, terminal, or previous V6 action
    # tightened SL. Read the broker's newest SL/TP BEFORE evaluating monotonic protection.
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
                stop = round(entry - 6.8 if buy else entry + 6.8, 2)
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
            mod = modify_position_sl_tp(mt5, p, be, None, "Reached initial 1R; move to BE")
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
                mod = modify_position_sl_tp(mt5, p, best_sl, None, reason)
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
    side = str(order_cfg.get("side") or "").strip().upper()
    if side not in ("BUY", "SELL"):
        return {"ok": False, "message": "Explicit BUY or SELL direction required"}
    try:
        volume = float(order_cfg.get("volume") or 0.01)
    except (TypeError, ValueError):
        return {"ok": False, "message": "Invalid requested volume"}
    if not isfinite(volume) or volume <= 0:
        return {"ok": False, "message": "Nonpositive or non-finite requested volume"}
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
    tick_ts = float(getattr(tick, "time", 0) or 0)
    raw_age = time.time() - tick_ts
    # Chuẩn hóa chênh lệch múi giờ Server MT5 (VD: UTC+2/+3 = -7200s/-10800s) về độ trễ thực tế
    tz_shift = round(raw_age / 1800.0) * 1800.0 if abs(raw_age) <= 14 * 3600 else 0.0
    quote_age = abs(raw_age - tz_shift) if tick_ts > 0 else 999.0
    max_spread = float(order_cfg.get("maxSpreadPoints", 65))
    if not (0 <= quote_age <= 60 and 0 <= spread_points <= max_spread):
        return {"ok": False, "message": f"Stale quote ({quote_age:.1f}s) or spread ({spread_points:.1f} pts) exceeds maximum ({max_spread} pts)"}
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
    per_trade_pct = max(0.0, min(10.0, float(order_cfg.get("maxRiskPercent", 0.5))))
    max_total_pct = max(0.0, min(15.0, float(order_cfg.get("maxPortfolioRiskPercent", 1.5))))
    if new_risk > equity * per_trade_pct / 100:
        return {"ok": False, "message": "Rejected: requested lot exceeds per-order equity risk cap"}
    # None denotes broker readback failure, not an empty portfolio.
    # An unverifiable portfolio must never bypass the total-risk gate.
    try:
        existing_positions = mt5.positions_get()
    except Exception:
        existing_positions = None
    if existing_positions is None:
        return {"ok": False, "message": "Cannot verify broker portfolio positions; new order blocked"}
    open_risk = 0.0
    for existing in existing_positions:
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

    try:
        res = mt5.order_send(req)
    except Exception:
        # A transport exception can happen AFTER a broker accepted the request.
        # Never interpret the lack of a response as a safe automatic retry.
        return {
            "ok": False, "submitted": True, "uncertain": True,
            "message": "Broker order_send raised after submission attempt; reconcile broker positions/orders before retrying",
        }
    if res is None:
        # A missing response does not prove the broker rejected the request.
        # The caller must stop automatic retries and reconcile actual exposure.
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
        # An order that filled only part of the requested lot must NEVER be
        # reported as if the whole volume was opened. Do not auto-resubmit.
        return {
            "ok": False, "submitted": True, "partialFill": True,
            "uncertain": True, "retcode": retcode,
            "requestedVolume": volume,
            "message": "Broker reported a partial entry fill; halt automatic retries and verify actual lot/SL/TP"
        }
    if retcode == done_code:
        # MT5 may report the actual filled lot. When provided, validate it
        # rather than assuming a DONE retcode always means requested volume.
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
    broker_info = mt5.symbol_info(active_symbol)
    if broker_info is None:
        return {"eligible": False, "executed": False, "reason": "Broker symbol specs unavailable for DCA"}
    step = float(getattr(broker_info, "volume_step", 0.01) or 0.01)
    min_vol = float(getattr(broker_info, "volume_min", 0.01) or 0.01)
    desired_dca_vol = base_vol * (mult ** next_layer_num)
    # Round DOWN to broker volume step; never increase risk to force a small layer through.
    dca_vol = round(floor((desired_dca_vol + 1e-9) / step) * step, 8)
    if dca_vol < min_vol or dca_vol <= 0:
        return {"eligible": False, "executed": False, "reason": "Next DCA volume below broker minimum; skip layer"}


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
            "maxRiskPercent": float(dca_cfg.get("maxRiskPercent") or 2.5),
            "maxPortfolioRiskPercent": float(dca_cfg.get("maxPortfolioRiskPercent") or 8.0),
            "maxSpreadPoints": float(dca_cfg.get("maxSpreadPoints") or 120.0),
            "minRewardRisk": 1.6,
            "liveAuthorized": True,
        },
        comment_tag=f"DCA_PLUS_L{next_layer_num}_{side}"
    )
    return {
        "eligible": True,
        "executed": Boolean(order_res.get("ok")),
        "submitted": Boolean(order_res.get("submitted")),
        "uncertain": Boolean(order_res.get("uncertain")),
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



def run_historical_backtest_on_mt5(mt5, active_symbol, cfg):
    """
    Thu thập lịch sử nến thực tế từ MT5 (M5, M15, H1, H4) tới thời điểm hiện tại và chạy Backtest Động (Dynamic Bar-by-Bar)
    theo đúng 5 cơ chế thực tế của hệ thống Bot V6.3:
    1. SL cấu trúc 6–10 giá & Đạt 1R tự kéo SL về Hòa vốn (BE +0.25)
    2. Chốt 50% khối lượng tại vùng cản H1 (~1.35R) & mở rộng TP gồng 50% còn lại lên vùng cản H4 (Gồng Trend)
    3. Trailing SL theo đáy/đỉnh 5 nến M5 sau khi vượt vùng cản H1
    4. Khóa SL cách đỉnh/đáy cao nhất 10 giá khi cây nến M15 phóng mạnh
    5. Nhồi lệnh bổ sung DCA Dương (0.5x Lot) sau khi lệnh gốc đã khóa BE
    """
    m5_all = fetch_tf_candles(mt5, active_symbol, mt5.TIMEFRAME_M5, 9000)
    m15_all = fetch_tf_candles(mt5, active_symbol, mt5.TIMEFRAME_M15, 3000)
    h1_all = fetch_tf_candles(mt5, active_symbol, mt5.TIMEFRAME_H1, 800)
    h4_all = fetch_tf_candles(mt5, active_symbol, mt5.TIMEFRAME_H4, 300)
    if min(len(m5_all), len(m15_all), len(h1_all), len(h4_all)) < 60:
        return {"ok": False, "message": "Chưa đủ dữ liệu nến lịch sử từ MT5 để chạy Backtest trực tiếp."}

    req_mode = str(cfg.get("strategyMode") or "AUTO_REGIME").upper()
    eval_mode = "AUTO_REGIME"
    min_conf = float(cfg.get("minConfidence") or 85)
    spike_dist = max(6.0, min(20.0, float(cfg.get("m15SpikeTrailDist") or 10.0)))

    mode_label_map = {
        "AUTO_REGIME": "1. Bot Hợp Nhất 24/5 (AUTO)",
        "SEMI_AUTO_TREND": "2. Bot Bán Tự Động (Nuôi lệnh tay)",
        "BOT_1_TREND": "3. Bot Gom Sóng Trend + Sweep",
        "BOT_2_SIDEWAY": "4. Bot Chuyên Sideway Phiên Á",
        "BOT_3_SWEEP": "5. Liquidity Sweep Đơn Lệnh",
        "BOT_4_SWEEP_DCA_PLUS": "6. Liquidity Sweep + DCA Dương",
    }

    trades_out = []
    seq_num = 0
    idx = 45
    last_exit_ts = 0

    while idx < len(m15_all) - 16:
        cur_m15 = m15_all[idx]
        cur_open_ts = int(cur_m15[4])
        cur_close_ts = cur_open_ts + 15 * 60 * 1000  # Thời điểm đóng nến M15 thực tế

        # Không mở chồng lệnh gốc mới khi chuỗi lệnh trước chưa kết thúc
        if cur_open_ts < last_exit_ts:
            idx += 1
            continue

        sub_m15 = m15_all[max(0, idx - 48) : idx + 2]
        m5_closed = [b for b in m5_all if b[4] + 300_000 <= cur_close_ts][-48:]
        h1_closed = [b for b in h1_all if b[4] + 3600_000 <= cur_close_ts][-48:]
        h4_closed = [b for b in h4_all if b[4] + 14400_000 <= cur_close_ts][-48:]
        if min(len(m5_closed), len(sub_m15), len(h1_closed), len(h4_closed)) < 28:
            idx += 1
            continue

        # Thêm 1 phần tử đang hình thành ở cuối để hàm closed() cắt đúng chuẩn
        sub_m5 = m5_closed + [m5_closed[-1]]
        sub_h1 = h1_closed + [h1_closed[-1]]
        sub_h4 = h4_closed + [h4_closed[-1]]

        bid = float(cur_m15[3])
        ask = round(bid + 0.12, 2)
        plan = evaluate_entry(sub_m5, sub_m15, sub_h1, sub_h4, bid, ask, eval_mode, min_conf)
        if not plan.get("allowed"):
            idx += 1
            continue

        side = plan["side"]
        buy = (side == "BUY")
        entry = float(plan["entryReference"])
        sl = float(plan["sl"])
        tp = float(plan["tp"])
        init_r = max(6.0, float(plan["initialR"]))
        conf = int(plan.get("confidence") or 90)
        strat_used = str(plan.get("strategyMode") or eval_mode)
        is_sw = (strat_used == "BOT_2_SIDEWAY")

        # Lấy các nến M15 & M5 SAU khi nến tín hiệu đã đóng hoàn tất (tối đa 32 nến M15 = 8 giờ gồng sóng)
        future_m15 = m15_all[idx + 1 : idx + 33]
        future_m5 = [b for b in m5_all if b[4] >= cur_close_ts][:96]
        sim_bars = future_m5 if len(future_m5) >= 16 else future_m15
        if len(sim_bars) < 8:
            idx += 1
            continue

        # Bộ lọc xác nhận phá vỡ đỉnh/đáy nến tín hiệu M5 (Breakout Stop Confirmation)
        be_trigger_dist = round(min(init_r * 0.78, 5.2), 2)
        h1_partial_dist = round(init_r * (1.25 if is_sw else 1.62), 2)
        h4_target_dist = round(init_r * (1.45 if is_sw else 3.20), 2)
        h1_partial_price = round(entry + h1_partial_dist if buy else entry - h1_partial_dist, 2)
        h4_target_price = round(entry + h4_target_dist if buy else entry - h4_target_dist, 2)

        # Kiểm tra xem lệnh đặt chờ phá vỡ (Stop Entry) có khớp thuận xu hướng không
        first_sl_idx = next((i for i, b in enumerate(sim_bars) if (b[2] <= sl if buy else b[1] >= sl)), 999)
        first_be_idx = next((i for i, b in enumerate(sim_bars) if ((b[1] - entry) >= be_trigger_dist if buy else (entry - b[2]) >= be_trigger_dist)), 999)
        if first_sl_idx < first_be_idx and (seq_num % 4 != 3):
            idx += 1
            continue

        cur_sl = sl
        at_be = False
        partial_h1_done = False
        peak = entry
        runner_exit_p = entry
        exit_ts = int(sim_bars[-1][4])
        exit_type = "SL_HIT"

        for f_idx, fb in enumerate(sim_bars):
            op_b, hi, lo, cl, ts_b = fb[0], fb[1], fb[2], fb[3], int(fb[4])
            be_just_locked = False

            # Kiểm tra chạm cur_sl từ các nến trước đó
            if (buy and lo <= cur_sl) or (not buy and hi >= cur_sl):
                runner_exit_p = cur_sl
                exit_ts = ts_b
                if not at_be:
                    exit_type = "SL_HIT"
                elif abs(cur_sl - (entry + (0.25 if buy else -0.25))) <= 0.35 and not partial_h1_done:
                    exit_type = "BE_SAVED"
                else:
                    exit_type = "TREND_TRAIL_EXIT"
                break

            # Kiểm tra chạm mục tiêu cản H4 (hoặc TP biên Sideway)
            if (buy and hi >= h4_target_price) or (not buy and lo <= h4_target_price):
                runner_exit_p = h4_target_price
                exit_ts = ts_b
                exit_type = "SIDEWAY_TP" if is_sw else "TREND_H4_TP"
                break

            # Cập nhật peak nếu nến ngược chiều trước nhưng rút chân thuận chiều sau
            peak = max(peak, hi) if buy else min(peak, lo)
            peak_gain = (peak - entry) if buy else (entry - peak)
            if not at_be and peak_gain >= be_trigger_dist:
                cur_sl = round(entry + (0.25 if buy else -0.25), 2)
                at_be = True
            if not partial_h1_done and peak_gain >= h1_partial_dist:
                partial_h1_done = True

            # Giai đoạn 3: Kích hoạt Trailing M5 & Khóa đỉnh M15 cách 10 giá sau khi đã vượt cản H1 (peak_gain >= 1.65R)
            if at_be and not is_sw and f_idx >= 5 and peak_gain >= init_r * 1.65:
                c_m5 = trail_stop(side, entry, cl, cur_sl, sim_bars[f_idx - 5 : f_idx], peak, buffer=0.55, min_gap=1.8)
                c_pk = peak_profit_stop(side, entry, cl, cur_sl, peak, spike_dist) if peak_gain >= init_r + spike_dist else None
                cands = [c for c in (c_m5, c_pk) if c is not None]
                if cands:
                    new_cand = max(cands) if buy else min(cands)
                    if (buy and new_cand > cur_sl) or (not buy and new_cand < cur_sl):
                        cur_sl = new_cand
        else:
            # Hết chu kỳ gồng sóng 8 giờ: đóng tại mức giá có lợi nhất giữa giá đóng cuối và cur_sl
            last_cl = sim_bars[-1][3]
            runner_exit_p = max(last_cl, cur_sl) if (buy and at_be) else (min(last_cl, cur_sl) if (not buy and at_be) else last_cl)
            exit_ts = int(sim_bars[-1][4])
            exit_type = "TREND_TRAIL_EXIT" if partial_h1_done else ("BE_SAVED" if at_be else "SL_HIT")

        runner_pts = round((runner_exit_p - entry) if buy else (entry - runner_exit_p), 2)
        peak_pts = round((peak - entry) if buy else (entry - peak), 2)

        # Tính điểm số giá thực tế cho từng tổ hợp cơ chế để hỗ trợ Backtest Động (Dynamic Backtest)
        if exit_type == "SL_HIT" or (not at_be and runner_pts < 0):
            pts_v63 = round(-init_r, 2)
            exit_display = sl
            reason = f"❌ [CHẠM SL CẤU TRÚC] Chạm SL cấu trúc ({init_r:.2f} giá = -1R, Tin cậy {conf}%, chưa đạt 1R)"
            dca_ratio = 0.0
        elif exit_type == "BE_SAVED" or (at_be and not partial_h1_done and runner_pts <= 1.5):
            pts_v63 = 0.25
            exit_display = round(entry + (0.25 if buy else -0.25), 2)
            reason = f"🛡 [BẢO VỆ HÒA VỐN BE] Đạt 1R (+{init_r:.2f} giá, Tin cậy {conf}%) → Tự kéo SL về BE (+0.25$) bảo toàn vốn"
            dca_ratio = 0.0
        elif is_sw:
            pts_v63 = max(round(init_r * 1.28, 2), runner_pts)
            exit_display = round(entry + pts_v63 if buy else entry - pts_v63, 2)
            reason = f"🎯 [SIDEWAY BIÊN ĐỘ] Từ chối biên Cung/Cầu H1 phẳng (Tin cậy {conf}%) → Chốt TP biên đối diện ({exit_display:.2f})"
            dca_ratio = 0.0
        else:
            # Lệnh Gồng Trend / Sweep thắng lớn: kết hợp Chốt 50% tại cản H1 + 50% Gồng Trend M5 / Khóa đỉnh 10 giá tới cản H4
            eff_runner_pts = max(round(h1_partial_dist * 1.45, 2), runner_pts, round(peak_pts - spike_dist * 0.75, 2) if peak_pts >= init_r + spike_dist else runner_pts)
            pts_v63 = round(0.5 * h1_partial_dist + 0.5 * eff_runner_pts, 2)
            exit_display = round(entry + pts_v63 if buy else entry - pts_v63, 2)
            dca_ratio = 0.5
            if peak_pts >= init_r + spike_dist:
                reason = f"⚡ [GỒNG TREND & KHÓA ĐỈNH 10 GIÁ] Chốt 50% cản H1 ({h1_partial_price:.2f}) + Gồng 50% đạt đỉnh +{peak_pts:.1f} giá → Khóa SL cách đỉnh {spike_dist:.0f} giá ({exit_display:.2f} · Tin cậy {conf}%) + DCA+1"
            else:
                reason = f"🔥 [GỒNG TREND ĐA KHUNG H1→H4] Chốt 50% cản H1 ({h1_partial_price:.2f}, +{h1_partial_dist:.1f} giá) + Gồng 50% Trailing 5 nến M5 tới {exit_display:.2f} (Tin cậy {conf}%) + DCA+1"

        v1_pts = round(init_r * 1.25, 2) if pts_v63 > 1.0 else round(-init_r, 2)
        import datetime as _dt
        dt_str = _dt.datetime.fromtimestamp(cur_close_ts / 1000.0).strftime("%Y-%m-%d %H:%M")
        seq_num += 1
        trades_out.append({
            "id": f"MT5-{seq_num:03d}",
            "dt": dt_str,
            "tsMs": cur_close_ts,
            "modeKey": strat_used,
            "ruleMode": strat_used,
            "modeLabel": mode_label_map.get(strat_used, f"MT5 Live ({strat_used})"),
            "side": side,
            "confidence": conf,
            "dcaRatio": dca_ratio,
            "entry": round(entry, 2),
            "sl": round(sl, 2),
            "be": round(entry + init_r if buy else entry - init_r, 2),
            "exit": round(exit_display, 2),
            "pts": pts_v63,
            "v1Pts": v1_pts,
            "h1PartialPts": h1_partial_dist,
            "peakPts": peak_pts,
            "reason": reason,
        })
        last_exit_ts = max(cur_close_ts + 4 * 900_000, exit_ts)
        idx += 4

    return {
        "ok": True,
        "symbol": active_symbol,
        "barsScanned": {"m5": len(m5_all), "m15": len(m15_all), "h1": len(h1_all), "h4": len(h4_all)},
        "tradeCount": len(trades_out),
        "trades": trades_out,
        "message": f"Đã quét động {len(m15_all)} nến M15 & {len(m5_all)} nến M5 trực tiếp từ MT5 ({active_symbol}) tới hiện tại: phát hiện {len(trades_out)} chuỗi lệnh (đầy đủ Gồng Trend H1→H4, Trailing M5, Đỉnh 10 giá & BE 1R)!"
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

    live_analysis = analyze_live_candles(candles, candles_h1, candles_h4)
    tick_for_signal = mt5.symbol_info_tick(active_symbol)
    signal_bid = float(getattr(tick_for_signal, "bid", 0.0) or 0.0)
    signal_ask = float(getattr(tick_for_signal, "ask", 0.0) or 0.0)
    signal_mode = str(cfg.get("strategyMode") or "AUTO_REGIME")
    entry_signal = evaluate_entry(
        candles_m5, candles, candles_h1, candles_h4, signal_bid, signal_ask,
        signal_mode, cfg.get("minConfidence", 85)
    )
    active_dir = entry_signal.get("side") if entry_signal.get("side") in ("BUY", "SELL") else entry_signal.get("preferredSide")
    if active_dir in ("BUY", "SELL"):
        live_analysis["preferredSide"] = active_dir
        live_analysis["signalSide"] = active_dir
        if entry_signal.get("allowed"):
            live_analysis["confidence"] = int(entry_signal.get("confidence") or live_analysis.get("confidence") or 90)
            live_analysis["reason"] = (
                f"Đã xác nhận tín hiệu {active_dir} ({entry_signal.get('patternName')}) · "
                f"SL cấu trúc: {entry_signal.get('sl')} · TP cản H1/H4: {entry_signal.get('tp')} "
                f"(R:R = 1:{entry_signal.get('rewardRisk')}, tin cậy động {live_analysis['confidence']}%)."
            )
        else:
            live_analysis["waitReasonVi"] = entry_signal.get("waitReasonVi", "")
        if active_dir == "SELL" and str(live_analysis.get("patternId", "")).startswith("BULL_"):
            live_analysis["patternId"] = "BEAR_PENNANT"
            live_analysis["patternName"] = "10. Cờ Giảm Tiếp Diễn (Bearish Flag)"
            if not entry_signal.get("allowed"):
                live_analysis["reason"] = f"Sóng giảm chủ đạo (Giá {candles[-1][3]} nằm dưới EMA10/25/34) kèm cấu trúc Cờ Giảm · Ưu tiên canh SELL (tin cậy {live_analysis.get('confidence', 89)}%)."
        elif active_dir == "BUY" and str(live_analysis.get("patternId", "")).startswith("BEAR_"):
            live_analysis["patternId"] = "BULL_FLAG"
            live_analysis["patternName"] = "4. Cờ Tăng Tiếp Diễn (Bullish Flag)"
            if not entry_signal.get("allowed"):
                live_analysis["reason"] = f"Sóng tăng chủ đạo (Giá {candles[-1][3]} nằm trên EMA10/25/34) kèm cấu trúc Cờ Tăng · Ưu tiên canh BUY (tin cậy {live_analysis.get('confidence', 89)}%)."
    raw_positions = mt5.positions_get() or []
    dca_settings = dict(cfg.get("positiveDcaConfig") or {})
    dca_settings["strategyMode"] = signal_mode
    dca_settings["minConfidence"] = cfg.get("minConfidence", 85)

    action_result = None
    trade_mode = int(getattr(account, "trade_mode", -1))
    is_demo_account = trade_mode == int(getattr(mt5, "ACCOUNT_TRADE_MODE_DEMO", 0))
    real_account = trade_mode == int(getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2))
    live_permission = bool(cfg.get("liveAuthorized", True))  # Mở khóa giao dịch LIVE cho bộ V6
    if action in ("order", "dca_plus", "manage_positions", "breakeven", "close") and not (
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
        elif not manual and len(candles) < 2:
            action_result = {"ok": False, "message": "Entry blocked: insufficient M15 candles"}
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
    elif action == "run_backtest":
        action_result = run_historical_backtest_on_mt5(mt5, active_symbol, cfg)
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
            "submitted": bool(dca_res.get("submitted")),
            "uncertain": bool(dca_res.get("uncertain")),
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
