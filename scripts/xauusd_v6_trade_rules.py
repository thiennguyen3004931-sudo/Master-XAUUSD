"""Pure, fail-closed XAUUSD V6 strategy rules. No broker calls here.

All candle arrays are [open, high, low, close, open_time_ms] in ascending order.
The final candle is treated as forming and must never create a signal.
Scores are heuristic setup scores, NOT calibrated win probabilities.
"""
from __future__ import annotations

from math import isfinite

SUPPORTED = {
    "AUTO_REGIME", "BOT_1_TREND", "BOT_2_SIDEWAY",
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


def _bias(bars):
    values = [bar[3] for bar in bars]
    fast = ema(values, 10)
    slow = ema(values, 25)
    if fast is None or slow is None:
        return "WAIT"
    if fast > slow and values[-1] > fast:
        return "BUY"
    if fast < slow and values[-1] < fast:
        return "SELL"
    return "WAIT"


def _m5_confirm(bars, side):
    if len(bars) < 4:
        return False
    last, prior = bars[-1], bars[-2]
    if side == "BUY":
        return last[3] > last[0] and last[3] >= prior[3]
    return last[3] < last[0] and last[3] <= prior[3]


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
    if side == "BUY":
        obstacles = sorted(
            b[1] for b in h1[-24:] + h4[-18:] if b[1] > entry + 0.25
        )
        if obstacles and obstacles[0] - entry < risk * min_rr + 0.25:
            return None
        target = obstacles[0] - 0.25 if obstacles else entry + risk * 2.2
        return round(target, 2) if target - entry >= min_rr * risk else None
    obstacles = sorted(
        (b[2] for b in h1[-24:] + h4[-18:] if b[2] < entry - 0.25), reverse=True
    )
    if obstacles and entry - obstacles[0] < risk * min_rr + 0.25:
        return None
    target = obstacles[0] + 0.25 if obstacles else entry - risk * 2.2
    return round(target, 2) if entry - target >= min_rr * risk else None


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
    h1bias, h4bias = _bias(h1), _bias(h4)
    score = 88  # heuristic gate only; never report as realized win probability
    if score < float(min_score):
        return wait("Setup score below configured threshold")

    def sweep(side):
        if not _m5_confirm(m5, side) or not _sweep(m15[:-1], last, side, vol):
            return None
        price = ask if side == "BUY" else bid
        return _plan(side, "BOT_3_SWEEP", "Confirmed Liquidity Sweep M15 + M5",
                     score, "Swept prior 8-bar extreme and closed back inside; M5 confirms",
                     price, last[2] if side == "BUY" else last[1],
                     vol, h1, h4, candle_ts)

    def trend(side):
        if not (_bias(m15) == side and h1bias == side and h4bias == side):
            return None
        if not _m5_confirm(m5, side):
            return None
        if not (_engulfing(prev, last, side) or (
            (last[3] > last[0] if side == "BUY" else last[3] < last[0])
            and abs(last[3] - last[0]) >= 0.45 * max(0.01, last[1] - last[2])
        )):
            return None
        price = ask if side == "BUY" else bid
        ref = min(b[2] for b in m5[-8:]) if side == "BUY" else max(b[1] for b in m5[-8:])
        return _plan(side, "BOT_1_TREND", "H4/H1/M15 trend + M5 confirmation",
                     score, "EMA10/25 alignment on H4/H1/M15; confirmed M15 body and M5",
                     price, ref, vol, h1, h4, candle_ts)

    def sideway(side):
        # Deliberately reject trending H1 markets; do not blindly trade any reversal.
        h1fast, h1slow = ema([b[3] for b in h1], 10), ema([b[3] for b in h1], 25)
        if h1fast is None or h1slow is None or abs(h1fast - h1slow) > 0.75 * h1_vol:
            return None
        if not _m5_confirm(m5, side):
            return None
        prior_range = m15[-21:-1]
        low, high = min(b[2] for b in prior_range), max(b[1] for b in prior_range)
        width = high - low
        if width < 2.0 * vol or width > 8.0 * vol:
            return None
        price = ask if side == "BUY" else bid
        if not low <= price <= high or not _rejection(last, side):
            return None
        if side == "BUY" and price > low + width * 0.25:
            return None
        if side == "SELL" and price < high - width * 0.25:
            return None
        ref = low if side == "BUY" else high
        target = round(high - max(0.3, vol * 0.1), 2) if side == "BUY" else round(low + max(0.3, vol * 0.1), 2)
        return _plan(side, "BOT_2_SIDEWAY", "Supply/Demand range rejection",
                     score, "M15 range edge + wick rejection + M5 confirmation; H1 is flat",
                     price, ref, vol, h1, h4, candle_ts,
                     target_override=target, minimum_rr=1.25)

    families = {
        "BOT_1_TREND": [trend],
        "BOT_2_SIDEWAY": [sideway],
        "BOT_3_SWEEP": [sweep],
        "BOT_4_SWEEP_DCA_PLUS": [sweep],
        "LIQUIDITY_SWEEP_AND_TREND": [sweep, trend],
        "AUTO_REGIME": [sweep, trend, sideway],
    }
    for strategy in families[mode]:
        for side in ("BUY", "SELL"):
            plan = strategy(side)
            if plan:
                plan["requestedMode"] = mode
                return plan
    return wait("No completed-bar entry setup with valid structural SL and reward/risk")


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
