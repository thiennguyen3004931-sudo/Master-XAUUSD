"""Pure, fail-closed XAUUSD V6 strategy rules. No broker calls here.

All candle arrays are [open, high, low, close, open_time_ms] in ascending order.
The final candle is treated as forming and must never create a signal.
Scores are heuristic setup scores, NOT calibrated win probabilities.
"""
from __future__ import annotations

from math import isfinite

SUPPORTED = {
    "AUTO_REGIME", "SEMI_AUTO_TREND", "BOT_1_TREND", "BOT_2_SIDEWAY",
    "BOT_3_SWEEP", "BOT_4_SWEEP_DCA_PLUS",
    "LIQUIDITY_SWEEP_AND_TREND",
}


def closed(bars):
    return list(bars[:-1]) if bars and len(bars) > 1 else []


def ema(values, period):
    if len(values) < period:
        return None
    result = sum(values[:period]) / period
    weight = 2.0 / (period + 1)
    for value in values[period:]:
        result = weight * value + (1.0 - weight) * result
    return result


def atr(bars, period=14):
    if len(bars) < period + 1:
        return None
    true_ranges = []
    for i in range(1, len(bars)):
        high, low, previous_close = bars[i][1], bars[i][2], bars[i - 1][3]
        true_ranges.append(max(high - low, abs(high - previous_close), abs(low - previous_close)))
    return sum(true_ranges[-period:]) / period


def _bias(bars, ref_price=None):
    values = [bar[3] for bar in bars]
    fast = ema(values, 10)
    slow = ema(values, 25)
    ema34 = ema(values, min(34, len(values)))
    if fast is None or slow is None:
        return "WAIT"
    cur = float(ref_price) if (ref_price is not None and isfinite(ref_price) and ref_price > 0) else values[-1]
    # Đồng nhất 100% với phân tích cấu trúc H4/H1/M15 (EMA34 + EMA10/25):
    # 1. Nếu giá xác nhận M15 hiện tại nằm trên EMA34 (và trên EMA10 hoặc EMA25) -> BUY
    if ema34 is not None and cur >= ema34 and (cur >= fast or fast >= slow or cur >= slow):
        return "BUY"
    if ema34 is not None and cur < ema34 and (cur <= fast or fast <= slow or cur <= slow):
        return "SELL"
    # 2. Nếu giá nằm trên cả EMA10 và EMA25 -> BUY; dưới cả EMA10 và EMA25 -> SELL
    if cur >= fast and cur >= slow:
        return "BUY"
    if cur <= fast and cur <= slow:
        return "SELL"
    # 3. Trong nhịp hồi giữa EMA10 và EMA25: giữ xu hướng theo EMA10 vs EMA25
    if fast > slow and cur >= slow:
        return "BUY"
    if fast < slow and cur <= slow:
        return "SELL"
    return "BUY" if cur >= slow else "SELL"


def _m5_confirm(bars, side):
    if len(bars) < 4:
        return False
    last, prior, prev2 = bars[-1], bars[-2], bars[-3]
    m5_fast = ema([b[3] for b in bars[-10:]], min(5, len(bars))) or last[3]
    if side == "BUY":
        if last[3] > last[0] and last[3] >= prior[3]:
            return True
        return last[3] >= m5_fast and last[3] > prev2[3] and (last[3] >= last[0] or prior[3] > prior[0])
    if last[3] < last[0] and last[3] <= prior[3]:
        return True
    return last[3] <= m5_fast and last[3] < prev2[3] and (last[3] <= last[0] or prior[3] < prior[0])


def _engulfing(prior, last, side):
    if side == "BUY":
        return prior[3] < prior[0] and last[3] > last[0] and last[0] <= prior[3] and last[3] >= prior[0]
    return prior[3] > prior[0] and last[3] < last[0] and last[0] >= prior[3] and last[3] <= prior[0]


def _rejection(last, side):
    high, low, op, cl = last[1], last[2], last[0], last[3]
    candle_range = max(0.01, high - low)
    if side == "BUY":
        return cl > op and (min(op, cl) - low) / candle_range >= 0.43
    return cl < op and (high - max(op, cl)) / candle_range >= 0.43


def _sweep(prior_bars, last, side, m15_atr):
    if len(prior_bars) < 8:
        return False
    prev = prior_bars[-8:]
    buffer = max(0.05, m15_atr * 0.05)
    if side == "BUY":
        old_low = min(b[2] for b in prev)
        return last[2] < old_low - buffer and last[3] > old_low and _rejection(last, "BUY")
    old_high = max(b[1] for b in prev)
    return last[1] > old_high + buffer and last[3] < old_high and _rejection(last, "SELL")


def _dynamic_sweep_score(last, m5, side, h1bias, h4bias):
    high, low, op, cl = last[1], last[2], last[0], last[3]
    candle_range = max(0.01, high - low)
    wick = (min(op, cl) - low) if side == "BUY" else (high - max(op, cl))
    wick_ratio = wick / candle_range
    score = 85
    if wick_ratio >= 0.60:
        score += 3
    elif wick_ratio >= 0.50:
        score += 2
    elif wick_ratio >= 0.45:
        score += 1
    if h1bias == side:
        score += 2
    if h4bias == side:
        score += 2
    if m5:
        m5_last = m5[-1]
        m5_range = max(0.01, m5_last[1] - m5_last[2])
        if abs(m5_last[3] - m5_last[0]) / m5_range >= 0.55:
            score += 2
    return min(94, max(85, int(round(score))))


def _dynamic_trend_score(prev, last, m15, m5, side, vol):
    candle_range = max(0.01, last[1] - last[2])
    body_ratio = abs(last[3] - last[0]) / candle_range
    score = 85
    if _engulfing(prev, last, side):
        score += 2
    if body_ratio >= 0.68:
        score += 2
    elif body_ratio >= 0.55:
        score += 1
    closes = [b[3] for b in m15]
    fast, slow = ema(closes, 10), ema(closes, 25)
    if fast is not None and slow is not None and vol > 0:
        spread_atr = abs(fast - slow) / vol
        if spread_atr >= 0.50:
            score += 2
        elif spread_atr >= 0.25:
            score += 1
    if len(m5) >= 2:
        m5_last, m5_prev = m5[-1], m5[-2]
        if (side == "BUY" and m5_last[3] > m5_prev[1]) or (side == "SELL" and m5_last[3] < m5_prev[2]):
            score += 2
        else:
            score += 1
    return min(94, max(85, int(round(score))))


def _dynamic_sideway_score(last, price, low, width, h1_diff_ratio, side):
    high_c, low_c, op, cl = last[1], last[2], last[0], last[3]
    candle_range = max(0.01, high_c - low_c)
    wick = (min(op, cl) - low_c) if side == "BUY" else (high_c - max(op, cl))
    wick_ratio = wick / candle_range
    edge_pos = (price - low) / max(0.01, width) if side == "BUY" else (low + width - price) / max(0.01, width)
    score = 85
    if h1_diff_ratio <= 0.35:
        score += 2
    elif h1_diff_ratio <= 0.55:
        score += 1
    if edge_pos <= 0.15:
        score += 2
    elif edge_pos <= 0.22:
        score += 1
    if wick_ratio >= 0.55:
        score += 2
    elif wick_ratio >= 0.48:
        score += 1
    return min(94, max(85, int(round(score))))


def _stop_price(side, price, reference, volatility, max_distance=10.0):
    """Never tighten an invalid structural stop to fit a maximum distance."""
    if reference is None or not isfinite(reference) or price <= 0:
        return None
    buffer = max(0.35, min(1.2, volatility * 0.15))
    raw = (price - reference + buffer) if side == "BUY" else (reference - price + buffer)
    if not isfinite(raw) or raw <= 0 or raw > max_distance:
        return None
    distance = max(6.0, raw)
    return round(price - distance if side == "BUY" else price + distance, 2)


def structural_stop(side, entry, m5_bars, m15_bars, max_distance=10.0):
    """Use only confirmed M5/M15 extremes; reject wide invalidations."""
    m5 = closed(m5_bars)
    m15 = closed(m15_bars)
    if len(m5) < 8 or len(m15) < 16:
        return None
    volatility = atr(m15)
    if volatility is None:
        return None
    reference = min(b[2] for b in m5[-8:]) if side == "BUY" else max(b[1] for b in m5[-8:])
    return _stop_price(side, entry, reference, volatility, max_distance)


def _target(side, entry, sl, h1, h4, min_rr=1.6):
    risk = abs(entry - sl)
    if risk < 0.01:
        return None
    min_dist = risk * min_rr
    if side == "BUY":
        valid_obstacles = sorted(
            b[1] for b in h1[-24:] + h4[-18:] if b[1] >= entry + min_dist + 0.25
        )
        target = valid_obstacles[0] - 0.25 if valid_obstacles else entry + risk * 2.2
        return round(target, 2) if target - entry >= min_dist - 1e-6 else None
    valid_obstacles = sorted(
        (b[2] for b in h1[-24:] + h4[-18:] if b[2] <= entry - min_dist - 0.25), reverse=True
    )
    target = valid_obstacles[0] + 0.25 if valid_obstacles else entry - risk * 2.2
    return round(target, 2) if entry - target >= min_dist - 1e-6 else None


def _plan(side, mode, label, score, reason, entry, reference, vol, h1, h4, candle_ts,
          target_override=None, minimum_rr=1.6):
    sl = _stop_price(side, entry, reference, vol)
    if sl is None:
        return None
    risk = abs(entry - sl)
    tp = target_override if target_override is not None else _target(side, entry, sl, h1, h4, minimum_rr)
    if tp is None or (tp - entry if side == "BUY" else entry - tp) < minimum_rr * risk:
        return None
    return {
        "allowed": True, "strategyMode": mode, "side": side,
        "patternName": label, "confidence": score, "reason": reason,
        "sl": round(sl, 2), "tp": round(tp, 2),
        "initialR": round(risk, 2), "rewardRisk": round(abs(tp - entry) / risk, 2),
        "entryReference": round(entry, 2), "closedM15Time": int(candle_ts),
    }


def evaluate_entry(m5_bars, m15_bars, h1_bars, h4_bars, bid, ask, mode="AUTO_REGIME", min_score=85):
    """Return a broker-independent entry plan or an explicit WAIT reason."""
    mode = str(mode or "AUTO_REGIME").upper()
    wait = lambda reason: {"allowed": False, "strategyMode": mode, "side": "WAIT", "reason": reason}
    if mode not in SUPPORTED:
        return wait("Unsupported or paused mode")
    m5, m15, h1, h4 = map(closed, (m5_bars, m15_bars, h1_bars, h4_bars))
    if min(len(m5), len(m15), len(h1), len(h4)) < 26:
        return wait("Insufficient confirmed multi-timeframe candles")
    if not all(isfinite(v) and v > 0 for v in (bid, ask)) or ask < bid:
        return wait("Invalid Bid/Ask")
    vol = atr(m15)
    h1_vol = atr(h1)
    if vol is None or h1_vol is None or vol <= 0 or h1_vol <= 0:
        return wait("Insufficient volatility evidence")
    last, prev = m15[-1], m15[-2]
    candle_ts = last[4]
    h1bias, h4bias = _bias(h1, last[3]), _bias(h4, last[3])
    threshold = float(min_score)

    def sweep(side):
        opp = "SELL" if side == "BUY" else "BUY"
        if h1bias == opp and h4bias == opp:
            return None
        if not _m5_confirm(m5, side) or not _sweep(m15[:-1], last, side, vol):
            return None
        dyn_score = _dynamic_sweep_score(last, m5, side, h1bias, h4bias)
        if dyn_score < threshold:
            return None
        price = ask if side == "BUY" else bid
        return _plan(side, "BOT_3_SWEEP", "Confirmed Liquidity Sweep M15 + M5",
                     dyn_score, f"Swept prior 8-bar extreme and closed back inside; M5 confirms (score {dyn_score})",
                     price, last[2] if side == "BUY" else last[1],
                     vol, h1, h4, candle_ts)

    def trend(side):
        m15_b = _bias(m15)
        h4_cl = h4[-1][3]
        h4_e10 = ema([b[3] for b in h4], 10) or h4_cl
        h4_aligned = (h4bias == side) or ((h4_cl >= h4_e10) if side == "BUY" else (h4_cl <= h4_e10))
        if not (m15_b == side and h1bias == side and h4_aligned):
            return None
        if not _m5_confirm(m5, side):
            return None
        last_body = abs(last[3] - last[0])
        last_rng = max(0.01, last[1] - last[2])
        dir_ok = (last[3] > last[0] and last[3] >= prev[3]) if side == "BUY" else (last[3] < last[0] and last[3] <= prev[3])
        if not (_engulfing(prev, last, side) or (dir_ok and last_body >= 0.40 * last_rng)):
            return None
        dyn_score = _dynamic_trend_score(prev, last, m15, m5, side, vol)
        if dyn_score < threshold:
            return None
        price = ask if side == "BUY" else bid
        for lookback in (8, 5, 3):
            ref_n = min(b[2] for b in m5[-lookback:]) if side == "BUY" else max(b[1] for b in m5[-lookback:])
            plan_n = _plan(side, "BOT_1_TREND", "H4/H1/M15 trend + M5 confirmation",
                           dyn_score, f"EMA10/25 alignment on H4/H1/M15; confirmed M15 body and M5 (score {dyn_score})",
                           price, ref_n, vol, h1, h4, candle_ts)
            if plan_n is not None:
                return plan_n
        return None

    def sideway(side):
        # Deliberately reject strongly trending H1 markets; allow Asian range consolidations.
        h1fast, h1slow = ema([b[3] for b in h1], 10), ema([b[3] for b in h1], 25)
        if h1fast is None or h1slow is None or abs(h1fast - h1slow) > 1.10 * h1_vol:
            return None
        if not _m5_confirm(m5, side):
            return None
        prior_range = m15[-21:-1]
        low, high = min(b[2] for b in prior_range), max(b[1] for b in prior_range)
        width = high - low
        if width < 1.8 * vol or width > 8.5 * vol:
            return None
        price = ask if side == "BUY" else bid
        if not low <= price <= high or not (_rejection(last, side) or _engulfing(prev, last, side)):
            return None
        if side == "BUY" and price > low + width * 0.30:
            return None
        if side == "SELL" and price < high - width * 0.30:
            return None
        h1_diff_ratio = abs(h1fast - h1slow) / max(0.01, h1_vol)
        dyn_score = _dynamic_sideway_score(last, price, low, width, h1_diff_ratio, side)
        if dyn_score < threshold:
            return None
        ref = low if side == "BUY" else high
        target = round(high - max(0.3, vol * 0.1), 2) if side == "BUY" else round(low + max(0.3, vol * 0.1), 2)
        return _plan(side, "BOT_2_SIDEWAY", "Supply/Demand range rejection",
                     dyn_score, f"M15 range edge + wick rejection + M5 confirmation; H1 is flat (score {dyn_score})",
                     price, ref, vol, h1, h4, candle_ts,
                     target_override=target, minimum_rr=1.25)

    families = {
        "BOT_1_TREND": [trend, sweep],
        "BOT_2_SIDEWAY": [sideway],
        "BOT_3_SWEEP": [sweep],
        "BOT_4_SWEEP_DCA_PLUS": [sweep],
        "LIQUIDITY_SWEEP_AND_TREND": [trend, sweep],
        "AUTO_REGIME": [trend, sweep, sideway],
        "SEMI_AUTO_TREND": [trend, sweep],
    }
    for strategy in families[mode]:
        for side in ("BUY", "SELL"):
            plan = strategy(side)
            if plan:
                plan["requestedMode"] = mode
                plan["preferredSide"] = side
                return plan

    m15bias = _bias(m15)
    closes_m15 = [b[3] for b in m15]
    fast_m15, slow_m15 = ema(closes_m15, 10), ema(closes_m15, 25)
    sell_votes = sum(1 for b in (h4bias, h1bias, m15bias) if b == "SELL")
    buy_votes = sum(1 for b in (h4bias, h1bias, m15bias) if b == "BUY")
    if sell_votes > buy_votes:
        pref_side = "SELL"
    elif buy_votes > sell_votes:
        pref_side = "BUY"
    else:
        pref_side = "SELL" if (fast_m15 is not None and slow_m15 is not None and fast_m15 < slow_m15) else "BUY"

    m5_ok = _m5_confirm(m5, pref_side)
    body_ratio = abs(last[3] - last[0]) / max(0.01, last[1] - last[2])
    dir_ok = (last[3] < last[0]) if pref_side == "SELL" else (last[3] > last[0])
    candle_ok = _engulfing(prev, last, pref_side) or (dir_ok and body_ratio >= 0.45)
    sweep_ok = _sweep(m15[:-1], last, pref_side, vol)
    ref_m5 = min(b[2] for b in m5[-8:]) if pref_side == "BUY" else max(b[1] for b in m5[-8:])
    stop_ok = _stop_price(pref_side, ask if pref_side == "BUY" else bid, ref_m5, vol) is not None

    missing_parts = []
    if not (h4bias == pref_side and h1bias == pref_side and m15bias == pref_side) and not sweep_ok:
        missing_parts.append(f"đa khung chưa đồng pha hoàn toàn (H4:{h4bias}, H1:{h1bias}, M15:{m15bias})")
    if not candle_ok and not sweep_ok:
        missing_parts.append(f"nến M15 vừa đóng chưa tạo Nhấn chìm {pref_side} (thân {int(body_ratio*100)}% < 45%) hoặc chưa Quét đỉnh/đáy 8 nến rút râu")
    if not m5_ok:
        missing_parts.append(f"nến M5 vừa đóng chưa xác nhận cùng chiều {pref_side}")
    if not stop_ok:
        missing_parts.append("khoảng cách đỉnh/đáy 8 nến M5 đang ngoài biên SL cấu trúc 6–10 giá")

    wait_vi = (
        f"Kịch bản ưu tiên canh {pref_side} — Đang đợi: " + "; ".join(missing_parts) + "."
        if missing_parts
        else f"Kịch bản ưu tiên canh {pref_side} — Đang đợi đóng nến M15 tiếp theo thỏa R:R >= 1.6."
    )
    res = wait("No completed-bar entry setup with valid structural SL and reward/risk")
    res["preferredSide"] = pref_side
    res["waitReasonVi"] = wait_vi
    res["h4Bias"] = h4bias
    res["h1Bias"] = h1bias
    res["m15Bias"] = m15bias
    return res


def trail_stop(side, entry, current, prior_sl, confirmed_m5, peak, buffer=0.35, min_gap=1.2):
    """No widening, no same-tick crossing; peak is persistent, per ticket."""
    if not confirmed_m5 or len(confirmed_m5) < 5:
        return None
    if side == "BUY":
        candidate = round(min(b[2] for b in confirmed_m5[-5:]) - buffer, 2)
        if candidate <= entry + 0.25 or candidate >= current - min_gap:
            return None
        return candidate if candidate > prior_sl + 0.15 else None
    candidate = round(max(b[1] for b in confirmed_m5[-5:]) + buffer, 2)
    if candidate >= entry - 0.25 or candidate <= current + min_gap:
        return None
    return candidate if prior_sl > 0 and candidate < prior_sl - 0.15 else None


def peak_profit_stop(side, entry, current, prior_sl, peak, distance=10.0, min_gap=0.8):
    if distance <= 0:
        return None
    if side == "BUY":
        candidate = round(peak - distance, 2)
        return candidate if entry + 0.25 < candidate < current - min_gap and candidate > prior_sl + 0.15 else None
    candidate = round(peak + distance, 2)
    return candidate if candidate < entry - 0.25 and candidate > current + min_gap and prior_sl > 0 and candidate < prior_sl - 0.15 else None
