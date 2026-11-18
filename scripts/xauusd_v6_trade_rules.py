"""Pure, fail-closed XAUUSD V6 strategy rules (Regime Classifier + Signal Engine + Position Manager).
No broker calls here.

Unit convention:
- 1 price unit ("1 giá") = 1.00 USD/oz on XAUUSD (distinct from broker `point`, which is typically 0.01 or 0.001).
- All candle arrays are [open, high, low, close, open_time_ms] in ascending order.
- The final candle in every timeframe array is treated as forming and must never create a signal or structural swing.
- Setup scores (`setupScore` / `confidence`) are heuristic setup points (0–100), NOT calibrated win probabilities.
"""
from __future__ import annotations

from math import isfinite

SUPPORTED = {
    "AUTO_REGIME",
    "SEMI_AUTO_TREND",
    "BOT_1_TREND",
    "BOT_2_SIDEWAY",
    "BOT_3_SWEEP",
    "BOT_4_SWEEP_DCA_PLUS",
    "LIQUIDITY_SWEEP_AND_TREND",
}

MIN_STRUCTURAL_SL_DIST = 6.0
MAX_STRUCTURAL_SL_DIST = 8.0
DEFAULT_ROUND_TRIP_COST_PTS = 0.08
DEFAULT_FALLBACK_OPEN_AIR_RR = 2.2
CANDLE_LOOKBACK_BARS = 60
WAIT_PULLBACK_MAX_AGE_MS = 3600_000  # 60 minutes (4 M15 bars) before WAIT_PULLBACK setup expires


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


def _bias(bars, ref_price=None, neutral_atr_ratio=0.12):
    """Classify timeframe directional bias into BUY, SELL, NEUTRAL, or WAIT.
    Does not force flat/intertwined EMAs into BUY/SELL.
    """
    if not bars or len(bars) < 25:
        return "WAIT"
    values = [float(bar[3]) for bar in bars]
    fast = ema(values, 10)
    slow = ema(values, 25)
    ema34 = ema(values, min(34, len(values)))
    tf_atr = atr(bars) or 0.0
    if fast is None or slow is None:
        return "WAIT"
    cur = float(ref_price) if (ref_price is not None and isfinite(ref_price) and ref_price > 0) else values[-1]

    # Neutral zone: when fast/slow EMAs are tightly compressed and price sits near the EMA band
    if tf_atr > 0 and abs(fast - slow) <= neutral_atr_ratio * tf_atr:
        band_low = min(fast, slow, ema34 if ema34 is not None else slow) - 0.15 * tf_atr
        band_high = max(fast, slow, ema34 if ema34 is not None else slow) + 0.15 * tf_atr
        if band_low <= cur <= band_high:
            return "NEUTRAL"

    if ema34 is not None and cur >= ema34 and fast > slow and cur >= slow:
        return "BUY"
    if ema34 is not None and cur < ema34 and fast < slow and cur <= slow:
        return "SELL"
    if cur > fast and fast > slow:
        return "BUY"
    if cur < fast and fast < slow:
        return "SELL"
    if ema34 is not None and cur >= ema34 and cur >= fast:
        return "BUY"
    if ema34 is not None and cur < ema34 and cur <= fast:
        return "SELL"
    return "NEUTRAL"


def _classify_single_slice_regime(m15, h1, h4):
    """Internal helper to classify regime on a slice of closed candles."""
    if min(len(m15), len(h1), len(h4)) < 25:
        return "UNKNOWN", {}
    vol_m15 = atr(m15)
    vol_h1 = atr(h1)
    if vol_m15 is None or vol_h1 is None or vol_m15 <= 0 or vol_h1 <= 0:
        return "UNKNOWN", {}

    last_close = float(m15[-1][3])
    h4_bias = _bias(h4, last_close)
    h1_bias = _bias(h1, last_close)
    m15_bias = _bias(m15, last_close)

    h1_closes = [float(b[3]) for b in h1]
    h1_fast, h1_slow = ema(h1_closes, 10), ema(h1_closes, 25)
    h1_ema_diff_ratio = abs((h1_fast or 0.0) - (h1_slow or 0.0)) / max(0.01, vol_h1)
    h1_flat = h1_fast is not None and h1_slow is not None and h1_ema_diff_ratio <= 1.10

    prior_range = m15[-21:-1] if len(m15) >= 21 else m15[-20:]
    box_low = min(float(b[2]) for b in prior_range)
    box_high = max(float(b[1]) for b in prior_range)
    box_width = box_high - box_low
    in_range_box = (1.8 * vol_m15 <= box_width <= 8.5 * vol_m15) and (box_low - 0.5 * vol_m15 <= last_close <= box_high + 0.5 * vol_m15)

    h4_closes = [float(b[3]) for b in h4]
    h4_e10 = ema(h4_closes, 10) or float(h4[-1][3])
    h4_up_ok = (h4_bias == "BUY") or (float(h4[-1][3]) >= h4_e10 and h4_bias != "SELL")
    h4_down_ok = (h4_bias == "SELL") or (float(h4[-1][3]) <= h4_e10 and h4_bias != "BUY")

    # 1. Clean consolidation range when H1 EMAs are flat and M15 is inside a bounded box
    if h1_flat and in_range_box and (h1_bias == "NEUTRAL" or h1_ema_diff_ratio <= 0.55):
        return "RANGE", {
            "h4Bias": h4_bias, "h1Bias": h1_bias, "m15Bias": m15_bias,
            "h1Flat": h1_flat, "h1EmaDiffRatio": round(h1_ema_diff_ratio, 3),
            "boxLow": round(box_low, 2), "boxHigh": round(box_high, 2), "boxWidth": round(box_width, 2),
            "m15Atr": round(vol_m15, 2), "h1Atr": round(vol_h1, 2),
        }

    # 2. Aligned uptrend across H4, H1, and M15
    if m15_bias == "BUY" and h1_bias == "BUY" and h4_up_ok:
        return "TREND_UP", {
            "h4Bias": h4_bias, "h1Bias": h1_bias, "m15Bias": m15_bias,
            "h1Flat": h1_flat, "h1EmaDiffRatio": round(h1_ema_diff_ratio, 3),
            "boxLow": round(box_low, 2), "boxHigh": round(box_high, 2), "boxWidth": round(box_width, 2),
            "m15Atr": round(vol_m15, 2), "h1Atr": round(vol_h1, 2),
        }

    # 3. Aligned downtrend across H4, H1, and M15
    if m15_bias == "SELL" and h1_bias == "SELL" and h4_down_ok:
        return "TREND_DOWN", {
            "h4Bias": h4_bias, "h1Bias": h1_bias, "m15Bias": m15_bias,
            "h1Flat": h1_flat, "h1EmaDiffRatio": round(h1_ema_diff_ratio, 3),
            "boxLow": round(box_low, 2), "boxHigh": round(box_high, 2), "boxWidth": round(box_width, 2),
            "m15Atr": round(vol_m15, 2), "h1Atr": round(vol_h1, 2),
        }

    # 4. Flat H1 range edge even if H1 bias slightly tilted
    if h1_flat and in_range_box and m15_bias == "NEUTRAL":
        return "RANGE", {
            "h4Bias": h4_bias, "h1Bias": h1_bias, "m15Bias": m15_bias,
            "h1Flat": h1_flat, "h1EmaDiffRatio": round(h1_ema_diff_ratio, 3),
            "boxLow": round(box_low, 2), "boxHigh": round(box_high, 2), "boxWidth": round(box_width, 2),
            "m15Atr": round(vol_m15, 2), "h1Atr": round(vol_h1, 2),
        }

    # 5. Otherwise timeframes are conflicting or transitioning
    return "TRANSITION", {
        "h4Bias": h4_bias, "h1Bias": h1_bias, "m15Bias": m15_bias,
        "h1Flat": h1_flat, "h1EmaDiffRatio": round(h1_ema_diff_ratio, 3),
        "boxLow": round(box_low, 2), "boxHigh": round(box_high, 2), "boxWidth": round(box_width, 2),
        "m15Atr": round(vol_m15, 2), "h1Atr": round(vol_h1, 2),
    }


def classify_market_regime(m5_bars, m15_bars, h1_bars, h4_bars, prior_regime=None, regime_state=None):
    """Step 1 of V6 Strategy Selector:
    Classify market using ONLY closed candles into:
      TREND_UP, TREND_DOWN, RANGE, TRANSITION, UNKNOWN
    Includes 2-bar stability / hysteresis check to prevent rapid regime flipping.
    """
    m5 = closed(m5_bars) if m5_bars and len(m5_bars) > 26 else list(m5_bars or [])
    m15 = closed(m15_bars) if m15_bars and len(m15_bars) > 26 else list(m15_bars or [])
    h1 = closed(h1_bars) if h1_bars and len(h1_bars) > 26 else list(h1_bars or [])
    h4 = closed(h4_bars) if h4_bars and len(h4_bars) > 26 else list(h4_bars or [])

    if min(len(m5), len(m15), len(h1), len(h4)) < 25:
        return {
            "regime": "UNKNOWN",
            "rawRegime": "UNKNOWN",
            "h4Bias": "WAIT",
            "h1Bias": "WAIT",
            "m15Bias": "WAIT",
            "hysteresisHeld": False,
            "reason": "Insufficient confirmed multi-timeframe candles (<25 closed bars)",
        }

    raw_now, details = _classify_single_slice_regime(m15, h1, h4)
    if raw_now == "UNKNOWN":
        return {
            "regime": "UNKNOWN",
            "rawRegime": "UNKNOWN",
            "h4Bias": "WAIT",
            "h1Bias": "WAIT",
            "m15Bias": "WAIT",
            "hysteresisHeld": False,
            "reason": "Invalid or nonpositive volatility (ATR)",
        }

    cur_m15_ts = int(m15[-1][4]) if m15 and len(m15[-1]) > 4 else 0
    raw_prev, _ = _classify_single_slice_regime(m15[:-1], h1, h4) if len(m15) >= 26 else (raw_now, {})
    effective_regime = raw_now
    hysteresis_held = False

    if isinstance(regime_state, dict):
        last_ts = int(regime_state.get("lastClosedM15Ts") or 0)
        stored_regime = regime_state.get("regime") or prior_regime
        if cur_m15_ts > 0 and cur_m15_ts == last_ts and stored_regime:
            effective_regime = stored_regime
            hysteresis_held = bool(regime_state.get("hysteresisHeld", False))
        else:
            if stored_regime in ("TREND_UP", "TREND_DOWN", "RANGE") and raw_now != stored_regime:
                opposite_flip = (
                    (stored_regime == "TREND_UP" and raw_now == "TREND_DOWN")
                    or (stored_regime == "TREND_DOWN" and raw_now == "TREND_UP")
                )
                pending = regime_state.get("pendingRegime")
                p_count = int(regime_state.get("pendingCount") or 0)
                if opposite_flip:
                    if pending == raw_now:
                        p_count += 1
                    else:
                        pending = raw_now
                        p_count = 1
                    if p_count < 2 and raw_prev != raw_now:
                        effective_regime = "TRANSITION"
                        hysteresis_held = True
                        regime_state["pendingRegime"] = pending
                        regime_state["pendingCount"] = p_count
                    else:
                        effective_regime = raw_now
                        regime_state["pendingRegime"] = None
                        regime_state["pendingCount"] = 0
                else:
                    regime_state["pendingRegime"] = None
                    regime_state["pendingCount"] = 0
            else:
                regime_state["pendingRegime"] = None
                regime_state["pendingCount"] = 0
            regime_state["regime"] = effective_regime
            regime_state["hysteresisHeld"] = hysteresis_held
            regime_state["lastClosedM15Ts"] = cur_m15_ts
    elif prior_regime in ("TREND_UP", "TREND_DOWN", "RANGE") and raw_now != prior_regime:
        opposite_flip = (
            (prior_regime == "TREND_UP" and raw_now == "TREND_DOWN")
            or (prior_regime == "TREND_DOWN" and raw_now == "TREND_UP")
        )
        if opposite_flip and raw_prev != raw_now:
            effective_regime = "TRANSITION"
            hysteresis_held = True

    reason_map = {
        "TREND_UP": f"TREND_UP: H4 ({details['h4Bias']}), H1 ({details['h1Bias']}), M15 ({details['m15Bias']}) aligned bullish",
        "TREND_DOWN": f"TREND_DOWN: H4 ({details['h4Bias']}), H1 ({details['h1Bias']}), M15 ({details['m15Bias']}) aligned bearish",
        "RANGE": f"RANGE: H1 flat (EMA diff {details['h1EmaDiffRatio']}x ATR) & M15 bounded box ({details['boxWidth']} USD/oz)",
        "TRANSITION": (
            f"TRANSITION: Multi-timeframe structure mixed or transitioning "
            f"(H4:{details['h4Bias']}, H1:{details['h1Bias']}, M15:{details['m15Bias']})"
        ),
    }
    return {
        "regime": effective_regime,
        "rawRegime": raw_now,
        "previousBarRegime": raw_prev,
        "hysteresisHeld": hysteresis_held,
        **details,
        "reason": reason_map.get(effective_regime, "UNKNOWN"),
    }


def _m5_confirm(bars, side):
    if len(bars) < 4:
        return False
    last, prior, prev2 = bars[-1], bars[-2], bars[-3]
    m5_fast = ema([b[3] for b in bars[-10:]], min(5, len(bars))) or last[3]
    if side == "BUY":
        if last[3] > last[0] and last[3] >= prior[3]:
            return True
        return last[3] >= m5_fast and last[3] > prev2[3] and (last[3] >= last[0] or prior[3] > prior[0])
    if side == "SELL":
        if last[3] < last[0] and last[3] <= prior[3]:
            return True
        return last[3] <= m5_fast and last[3] < prev2[3] and (last[3] <= last[0] or prior[3] < prior[0])
    return False


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
    """Heuristic setup score (points out of 100, NOT win probability)."""
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
    """Heuristic setup score (points out of 100, NOT win probability)."""
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
    """Heuristic setup score (points out of 100, NOT win probability)."""
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


def _raw_stop_distance(side, price, reference, volatility):
    """Calculate raw structural SL distance (swing extreme + ATR safety buffer) in USD/oz (1 giá = 1 USD/oz)."""
    if (reference is None or not isfinite(reference) or price <= 0
            or volatility is None or not isfinite(volatility) or volatility <= 0):
        return None
    buffer = max(0.35, min(1.2, volatility * 0.15))
    raw = (price - reference + buffer) if side == "BUY" else (reference - price + buffer)
    if not isfinite(raw) or raw <= 0:
        return None
    return round(raw, 4)


def _stop_price(side, price, reference, volatility, max_distance=MAX_STRUCTURAL_SL_DIST):
    """Target structural SL in [6.0, 8.0] USD/oz (outside structure).
    - If raw < 6.0, widen outward to 6.0 (remains strictly outside structural invalidation level).
    - If raw > max_distance (8.0), return None (never pull SL inside structure; caller returns WAIT_PULLBACK).
    """
    raw = _raw_stop_distance(side, price, reference, volatility)
    if raw is None or raw > max_distance:
        return None
    distance = max(MIN_STRUCTURAL_SL_DIST, raw)
    sl_price = round(price - distance if side == "BUY" else price + distance, 2)
    if side == "BUY" and sl_price >= reference:
        return None
    if side == "SELL" and sl_price <= reference:
        return None
    return sl_price


def structural_stop(side, entry, m5_bars, m15_bars, max_distance=MAX_STRUCTURAL_SL_DIST):
    """Use strictly the 8 confirmed M5 candles; reject wide invalidations (> 8.0 USD/oz)."""
    m5 = closed(m5_bars)
    m15 = closed(m15_bars)
    if len(m5) < 8 or len(m15) < 16:
        return None
    volatility = atr(m15)
    if volatility is None:
        return None
    reference = min(b[2] for b in m5[-8:]) if side == "BUY" else max(b[1] for b in m5[-8:])
    return _stop_price(side, entry, reference, volatility, max_distance)


def _extract_opposing_h1_h4_obstacles(side, entry, h1, h4, min_clearance=0.0):
    """Identify confirmed opposing swing highs/lows and structural extremes on H1 and H4 ahead of entry.
    Sorted from NEAREST to FARTHEST relative to entry.
    """
    obstacles = set()
    for series in (h1[-24:] if h1 else [], h4[-18:] if h4 else []):
        n = len(series)
        for i in range(n):
            hi = round(float(series[i][1]), 2)
            lo = round(float(series[i][2]), 2)
            is_swing_high = (0 < i < n - 1 and hi >= float(series[i - 1][1]) and hi >= float(series[i + 1][1]))
            is_swing_low = (0 < i < n - 1 and lo <= float(series[i - 1][2]) and lo <= float(series[i + 1][2]))
            if side == "BUY" and hi > entry + min_clearance:
                if is_swing_high or hi >= max(float(b[1]) for b in series):
                    obstacles.add(hi)
            elif side == "SELL" and lo < entry - min_clearance:
                if is_swing_low or lo <= min(float(b[2]) for b in series):
                    obstacles.add(lo)

    if side == "BUY":
        return sorted(obstacles)
    return sorted(obstacles, reverse=True)


def select_tp_with_near_obstacle_check(
    side,
    entry,
    sl,
    h1,
    h4,
    min_rr=1.6,
    round_trip_cost=DEFAULT_ROUND_TRIP_COST_PTS,
    fallback_rr=DEFAULT_FALLBACK_OPEN_AIR_RR,
    obstacle_buffer=0.25,
):
    """Select TP while strictly respecting the NEAREST opposing H1/H4 obstacle (Section 3.2):
    1. Locate the nearest confirmed opposing obstacle on H1/H4 ahead of entry.
    2. Check available room from entry to (nearest_obstacle -/+ buffer) AFTER deducting round_trip_cost.
    3. If net R:R to the nearest obstacle is < min_rr:
       return ok=False, status='NEAR_OBSTACLE_INSUFFICIENT_RR' (NO_TRADE / wait breakout-retest).
       NEVER skip over a near obstacle that blocks R:R just to pick a farther obstacle!
    4. If no opposing H1/H4 obstacle exists ahead of entry (open air):
       use explicit fallback R multiple (`FALLBACK_FIXED_RR_OPEN_AIR`) and label it honestly as fallback R,
       never as a confirmed S/R obstacle.
    """
    risk = abs(float(entry) - float(sl))
    if not isfinite(risk) or risk < 0.01:
        return {"ok": False, "tp": None, "tpSource": "INVALID_RISK", "reason": "Invalid SL risk distance"}

    cost = max(0.0, float(round_trip_cost or 0.0))
    obstacles = _extract_opposing_h1_h4_obstacles(side, entry, h1, h4)

    if obstacles:
        nearest = obstacles[0]
        candidate_tp = round(nearest - obstacle_buffer if side == "BUY" else nearest + obstacle_buffer, 2)
        gross_reward = (candidate_tp - entry) if side == "BUY" else (entry - candidate_tp)
        net_reward = gross_reward - cost
        gross_rr = gross_reward / risk
        net_rr = net_reward / risk
        if net_rr < min_rr - 1e-6:
            return {
                "ok": False,
                "tp": None,
                "tpSource": "BLOCKED_BY_NEAR_OBSTACLE",
                "nearestObstacle": round(nearest, 2),
                "BlockedTpCandidate": candidate_tp,
                "grossRewardRisk": round(gross_rr, 2),
                "netRewardRisk": round(net_rr, 2),
                "requiredRewardRisk": min_rr,
                "reason": (
                    f"NO_TRADE (Near obstacle block): Nearest H1/H4 obstacle at {nearest:.2f} "
                    f"caps TP at {candidate_tp:.2f} (net R:R {net_rr:.2f} < {min_rr:.2f} after {cost:.2f} USD/oz cost); "
                    f"do not skip near obstacle — wait for breakout-retest"
                ),
                "waitReasonVi": (
                    f"NO_TRADE (Vướng cản gần H1/H4): Vùng cản đối diện gần nhất tại {nearest:.2f} chỉ cho TP {candidate_tp:.2f} "
                    f"(R:R ròng sau phí = 1:{net_rr:.2f} < mức tối thiểu 1:{min_rr:.2f}). "
                    f"Không bỏ qua cản gần để lấy cản xa — chờ giá phá vỡ & retest."
                ),
            }
        return {
            "ok": True,
            "tp": candidate_tp,
            "tpSource": "CONFIRMED_H1_H4_OBSTACLE",
            "nearestObstacle": round(nearest, 2),
            "grossRewardRisk": round(gross_rr, 2),
            "netRewardRisk": round(net_rr, 2),
            "tpReason": f"TP trước vùng cản H1/H4 gần nhất ({nearest:.2f}, R:R ròng 1:{net_rr:.2f})",
        }

    # Open air (no opposing H1/H4 swing ahead of entry): explicit fallback R-multiple policy
    eff_fallback_rr = max(float(fallback_rr or DEFAULT_FALLBACK_OPEN_AIR_RR), float(min_rr) + (cost / risk) + 0.1)
    candidate_tp = round(entry + risk * eff_fallback_rr if side == "BUY" else entry - risk * eff_fallback_rr, 2)
    gross_reward = abs(candidate_tp - entry)
    net_reward = gross_reward - cost
    net_rr = net_reward / risk
    if net_rr < min_rr - 1e-6:
        return {"ok": False, "tp": None, "tpSource": "FALLBACK_INSUFFICIENT_RR", "reason": "Fallback TP below minimum net R:R"}
    return {
        "ok": True,
        "tp": candidate_tp,
        "tpSource": "FALLBACK_FIXED_RR_OPEN_AIR",
        "nearestObstacle": None,
        "grossRewardRisk": round(gross_reward / risk, 2),
        "netRewardRisk": round(net_rr, 2),
        "tpReason": f"TP dự phòng theo bội số {eff_fallback_rr:.1f}R (Không có cản H1/H4 phía trước — Chính sách Fallback Open-Air)",
    }


def _target(side, entry, sl, h1, h4, min_rr=1.6, round_trip_cost=DEFAULT_ROUND_TRIP_COST_PTS):
    res = select_tp_with_near_obstacle_check(side, entry, sl, h1, h4, min_rr=min_rr, round_trip_cost=round_trip_cost)
    return res["tp"] if res.get("ok") else None


def _plan(
    side,
    mode,
    label,
    score,
    reason,
    entry,
    reference,
    vol,
    h1,
    h4,
    candle_ts,
    target_override=None,
    minimum_rr=1.6,
    round_trip_cost=DEFAULT_ROUND_TRIP_COST_PTS,
    obstacle_rejections=None,
):
    sl = _stop_price(side, entry, reference, vol, max_distance=MAX_STRUCTURAL_SL_DIST)
    if sl is None:
        return None
    risk = abs(entry - sl)
    cost = max(0.0, float(round_trip_cost or 0.0))

    if target_override is not None:
        tp = round(float(target_override), 2)
        tp_source = "SIDEWAY_OPPOSITE_BOUNDARY"
        nearest_obs = tp
        sw_obstacles = _extract_opposing_h1_h4_obstacles(side, entry, h1, h4, min_clearance=0.0)
        blocking_obs = [
            o for o in sw_obstacles
            if (side == "BUY" and entry < o < tp) or (side == "SELL" and tp < o < entry)
        ]
        if blocking_obs:
            nearest_sw_obs = blocking_obs[0]
            clamped_tp = round(nearest_sw_obs - 0.25 if side == "BUY" else nearest_sw_obs + 0.25, 2)
            clamped_net = ((clamped_tp - entry) if side == "BUY" else (entry - clamped_tp)) - cost
            clamped_rr = clamped_net / risk
            if clamped_rr < minimum_rr - 1e-6:
                if obstacle_rejections is not None:
                    obstacle_rejections.append({
                        "side": side,
                        "strategyMode": mode,
                        "patternName": label,
                        "nearestObstacle": round(nearest_sw_obs, 2),
                        "netRewardRisk": round(clamped_rr, 2),
                        "requiredRewardRisk": minimum_rr,
                        "reason": f"NO_TRADE (Sideway near H1/H4 obstacle at {nearest_sw_obs:.2f}): net R:R {clamped_rr:.2f} < {minimum_rr:.2f}",
                        "waitReasonVi": f"NO_TRADE (Sideway vướng cản H1/H4 gần tại {nearest_sw_obs:.2f}): R:R ròng = 1:{clamped_rr:.2f} < 1:{minimum_rr:.2f}.",
                    })
                return None
            tp = clamped_tp
            tp_source = "SIDEWAY_CLAMPED_TO_H1_H4_OBSTACLE"
            nearest_obs = nearest_sw_obs
        gross_reward = (tp - entry) if side == "BUY" else (entry - tp)
        net_reward = gross_reward - cost
        net_rr = net_reward / risk
        if net_rr < minimum_rr - 1e-6:
            return None
        tp_reason = (
            f"TP tại cản H1/H4 gần hơn biên hộp ({nearest_obs:.2f}, R:R ròng 1:{net_rr:.2f})"
            if tp_source == "SIDEWAY_CLAMPED_TO_H1_H4_OBSTACLE"
            else f"TP trước biên đối diện hộp M15 (có đệm an toàn, R:R ròng 1:{net_rr:.2f})"
        )
    else:
        tp_sel = select_tp_with_near_obstacle_check(
            side, entry, sl, h1, h4, min_rr=minimum_rr, round_trip_cost=cost
        )
        if not tp_sel.get("ok"):
            if obstacle_rejections is not None and tp_sel.get("tpSource") == "BLOCKED_BY_NEAR_OBSTACLE":
                obstacle_rejections.append({
                    "side": side,
                    "strategyMode": mode,
                    "patternName": label,
                    "nearestObstacle": tp_sel.get("nearestObstacle"),
                    "netRewardRisk": tp_sel.get("netRewardRisk"),
                    "requiredRewardRisk": minimum_rr,
                    "reason": tp_sel.get("reason"),
                    "waitReasonVi": tp_sel.get("waitReasonVi"),
                })
            return None
        tp = tp_sel["tp"]
        gross_reward = abs(tp - entry)
        net_rr = tp_sel["netRewardRisk"]
        tp_source = tp_sel["tpSource"]
        tp_reason = tp_sel["tpReason"]
        nearest_obs = tp_sel.get("nearestObstacle")

    return {
        "allowed": True,
        "status": "ENTRY_OK",
        "strategyMode": mode,
        "side": side,
        "patternName": label,
        "setupScore": int(score),
        "confidence": int(score),
        "scoreType": "HEURISTIC_POINTS_OUT_OF_100",
        "reason": reason,
        "sl": round(sl, 2),
        "tp": round(tp, 2),
        "tpSource": tp_source,
        "tpReason": tp_reason,
        "nearestObstacle": nearest_obs,
        "structuralInvalidationPrice": round(float(reference), 2),
        "initialR": round(risk, 2),
        "rewardRisk": round(gross_reward / risk, 2),
        "netRewardRisk": round(net_rr, 2),
        "roundTripCostPts": round(cost, 2),
        "entryReference": round(entry, 2),
        "closedM15Time": int(candle_ts),
    }


def evaluate_wait_pullback_expiry(wait_state, current_ts_ms):
    """Fail closed on missing, corrupt, or inconsistent WAIT_PULLBACK timestamps."""
    invalid = {
        "active": False,
        "expired": True,
        "status": "WAIT_PULLBACK_INVALID_STATE",
        "reason": "Missing or invalid WAIT_PULLBACK timestamp state",
    }
    if not isinstance(wait_state, dict):
        return invalid
    try:
        # Reject booleans, non-integral floats, and malformed timestamps instead
        # of silently converting them into a seemingly valid entry window.
        fields = (wait_state.get("createdAtTs"), wait_state.get("expiresAtTs"), current_ts_ms)
        if any(isinstance(value, bool) or value is None for value in fields):
            return invalid
        created_ts, expires_ts, cur_ts = (int(value) for value in fields)
        if any(str(value).strip() != str(parsed) for value, parsed in zip(fields, (created_ts, expires_ts, cur_ts))):
            return invalid
    except (ValueError, TypeError, OverflowError):
        return invalid
    if (
        created_ts <= 0 or cur_ts <= 0
        or expires_ts <= created_ts
        or expires_ts - created_ts > WAIT_PULLBACK_MAX_AGE_MS
        or cur_ts < created_ts
    ):
        return invalid
    if cur_ts > expires_ts:
        return {"active": False, "expired": True, "status": "WAIT_PULLBACK_EXPIRED", "reason": "WAIT_PULLBACK setup expired"}
    return {"active": True, "expired": False, "status": "WAIT_PULLBACK_ACTIVE", "remainingMs": expires_ts - cur_ts}


def evaluate_entry(
    m5_bars,
    m15_bars,
    h1_bars,
    h4_bars,
    bid,
    ask,
    mode="AUTO_REGIME",
    min_score=85,
    prior_regime=None,
    round_trip_cost=DEFAULT_ROUND_TRIP_COST_PTS,
    regime_state=None,
):
    """5-Step Strategy Selection & Entry Evaluation Pipeline (Section 3.1 & 3.2):
    Step 1: Classify market regime (TREND_UP, TREND_DOWN, RANGE, TRANSITION, UNKNOWN) on closed bars.
    Step 2: Filter strategies eligible for the classified regime and requested mode.
    Step 3: Collect all valid candidate signals (checking 6-8 USD/oz structural SL and near-obstacle net R:R).
    Step 4: Reject immediately with NO_TRADE if conflicting BUY and SELL signals occur on the same bar.
    Step 5: Select the single highest-scoring valid signal or return NO_TRADE / WAIT_PULLBACK with explicit reason.
    """
    mode = str(mode or "AUTO_REGIME").upper()
    wait = lambda reason, status="NO_TRADE", extra=None: {
        "allowed": False,
        "status": status,
        "strategyMode": mode,
        "side": "WAIT",
        "reason": reason,
        **(extra or {}),
    }
    if mode not in SUPPORTED:
        return wait("Unsupported or paused mode", extra={"marketRegime": "UNKNOWN"})
    m5, m15, h1, h4 = map(closed, (m5_bars, m15_bars, h1_bars, h4_bars))
    if min(len(m5), len(m15), len(h1), len(h4)) < 26:
        return wait("Insufficient confirmed multi-timeframe candles", extra={"marketRegime": "UNKNOWN"})
    if not all(isfinite(v) and v > 0 for v in (bid, ask)) or ask < bid:
        return wait("Invalid Bid/Ask", extra={"marketRegime": "UNKNOWN"})
    vol = atr(m15)
    h1_vol = atr(h1)
    if vol is None or h1_vol is None or vol <= 0 or h1_vol <= 0:
        return wait("Insufficient volatility evidence", extra={"marketRegime": "UNKNOWN"})

    # Step 1: Market Regime Classification on closed candles
    regime_info = classify_market_regime(m5_bars, m15_bars, h1_bars, h4_bars, prior_regime=prior_regime, regime_state=regime_state)
    market_regime = regime_info["regime"]
    last, prev = m15[-1], m15[-2]
    candle_ts = last[4]
    h1bias = regime_info.get("h1Bias") or _bias(h1, last[3])
    h4bias = regime_info.get("h4Bias") or _bias(h4, last[3])
    m15bias = regime_info.get("m15Bias") or _bias(m15, last[3])
    threshold = float(min_score)
    pullback_candidates = []
    obstacle_rejections = []

    def _record_pullback_if_wide(side, fam_mode, label, price, ref_price):
        raw_dist = _raw_stop_distance(side, price, ref_price, vol)
        if raw_dist is not None and raw_dist > MAX_STRUCTURAL_SL_DIST:
            pullback_needed = round(raw_dist - MAX_STRUCTURAL_SL_DIST, 2)
            pullback_candidates.append({
                "allowed": False,
                "status": "WAIT_PULLBACK",
                "strategyMode": fam_mode,
                "requestedMode": mode,
                "marketRegime": market_regime,
                "side": "WAIT",
                "preferredSide": side,
                "patternName": label,
                "rawStructuralSlDistance": round(raw_dist, 2),
                "maxAllowedSlDistance": MAX_STRUCTURAL_SL_DIST,
                "requiredPullbackDistance": pullback_needed,
                "reason": (
                    f"WAIT_PULLBACK: {label} ({side}) has structural SL {raw_dist:.2f} USD/oz "
                    f"(> {MAX_STRUCTURAL_SL_DIST:.1f} USD/oz cap); wait for pullback >= {pullback_needed:.2f} USD/oz"
                ),
                "waitReasonVi": (
                    f"WAIT_PULLBACK (Chờ hồi giá): Tín hiệu {side} ({label}) đã xác nhận nhưng khoảng cách "
                    f"SL cấu trúc 8 nến M5 ({raw_dist:.2f} giá) vượt trần {MAX_STRUCTURAL_SL_DIST:.1f} giá. "
                    f"Chờ giá hồi lại tối thiểu {pullback_needed:.2f} giá để SL nằm trong chuẩn 6.0–8.0 giá."
                ),
                "h4Bias": h4bias,
                "h1Bias": h1bias,
                "m15Bias": m15bias,
                "closedM15Time": int(candle_ts),
            })

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
        ref_p = last[2] if side == "BUY" else last[1]
        plan_s = _plan(
            side,
            "BOT_3_SWEEP",
            "Confirmed Liquidity Sweep M15 + M5",
            dyn_score,
            f"Swept prior 8-bar M15 extreme and closed back inside; M5 confirms (setupScore {dyn_score}/100)",
            price,
            ref_p,
            vol,
            h1,
            h4,
            candle_ts,
            minimum_rr=1.6,
            round_trip_cost=round_trip_cost,
            obstacle_rejections=obstacle_rejections,
        )
        if plan_s is None:
            _record_pullback_if_wide(side, "BOT_3_SWEEP", "Confirmed Liquidity Sweep M15 + M5", price, ref_p)
        return plan_s

    def trend(side):
        h4_cl = h4[-1][3]
        h4_e10 = ema([b[3] for b in h4], 10) or h4_cl
        h4_aligned = (h4bias == side) or ((h4_cl >= h4_e10 and h4bias != "SELL") if side == "BUY" else (h4_cl <= h4_e10 and h4bias != "BUY"))
        if not (m15bias == side and h1bias == side and h4_aligned):
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
        ref_8 = min(b[2] for b in m5[-8:]) if side == "BUY" else max(b[1] for b in m5[-8:])
        plan_t = _plan(
            side,
            "BOT_1_TREND",
            "H4/H1/M15 trend + M5 confirmation",
            dyn_score,
            f"EMA10/25/34 alignment on H4/H1/M15; confirmed M15 body and M5 (setupScore {dyn_score}/100)",
            price,
            ref_8,
            vol,
            h1,
            h4,
            candle_ts,
            minimum_rr=1.6,
            round_trip_cost=round_trip_cost,
            obstacle_rejections=obstacle_rejections,
        )
        if plan_t is None:
            _record_pullback_if_wide(side, "BOT_1_TREND", "H4/H1/M15 trend + M5 confirmation", price, ref_8)
        return plan_t

    def sideway(side):
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
        edge_buffer = max(0.30, round(vol * 0.10, 2))
        target = round(high - edge_buffer, 2) if side == "BUY" else round(low + edge_buffer, 2)
        plan_sw = _plan(
            side,
            "BOT_2_SIDEWAY",
            "Supply/Demand range rejection",
            dyn_score,
            f"M15 20-bar range edge + wick rejection + M5 confirmation; H1 EMA flat (setupScore {dyn_score}/100)",
            price,
            ref,
            vol,
            h1,
            h4,
            candle_ts,
            target_override=target,
            minimum_rr=1.25,
            round_trip_cost=round_trip_cost,
            obstacle_rejections=obstacle_rejections,
        )
        if plan_sw is None:
            _record_pullback_if_wide(side, "BOT_2_SIDEWAY", "Supply/Demand range rejection", price, ref)
        return plan_sw

    # Step 2: Select eligible strategies based on classified market regime & user mode
    if mode == "AUTO_REGIME":
        if market_regime == "TREND_UP":
            strategy_evaluations = [(trend, "BUY"), (sweep, "BUY"), (trend, "SELL"), (sweep, "SELL")]
        elif market_regime == "TREND_DOWN":
            strategy_evaluations = [(trend, "SELL"), (sweep, "SELL"), (trend, "BUY"), (sweep, "BUY")]
        elif market_regime == "RANGE":
            strategy_evaluations = [(sideway, "BUY"), (sideway, "SELL"), (sweep, "BUY"), (sweep, "SELL")]
        else:
            strategy_evaluations = []
    else:
        families = {
            "BOT_1_TREND": [trend, sweep],
            "BOT_2_SIDEWAY": [sideway],
            "BOT_3_SWEEP": [sweep],
            "BOT_4_SWEEP_DCA_PLUS": [sweep],
            "LIQUIDITY_SWEEP_AND_TREND": [trend, sweep],
            "SEMI_AUTO_TREND": [trend, sweep],
        }
        strategy_evaluations = [(fn, s) for fn in families[mode] for s in ("BUY", "SELL")]

    # Step 3: Collect all valid candidate signals
    valid_candidates = []
    for strategy_fn, side in strategy_evaluations:
        cand = strategy_fn(side)
        if cand is not None:
            valid_candidates.append(cand)

    buy_candidates = [c for c in valid_candidates if c["side"] == "BUY"]
    sell_candidates = [c for c in valid_candidates if c["side"] == "SELL"]
    both_m5_confirm = _m5_confirm(m5, "BUY") and _m5_confirm(m5, "SELL")
    both_sweep_raw = _sweep(m15[:-1], last, "BUY", vol) and _sweep(m15[:-1], last, "SELL", vol)

    # Step 4: Conflict detection — if both BUY and SELL are valid simultaneously, return NO_TRADE
    if (buy_candidates and sell_candidates) or both_m5_confirm or both_sweep_raw:
        return wait(
            "NO_TRADE: Conflicting BUY and SELL signals detected on the same closed bar",
            status="NO_TRADE",
            extra={
                "requestedMode": mode,
                "marketRegime": market_regime,
                "conflictDetected": True,
                "preferredSide": "NEUTRAL",
                "h4Bias": h4bias,
                "h1Bias": h1bias,
                "m15Bias": m15bias,
                "waitReasonVi": "NO_TRADE (Xung đột tín hiệu): Cả chiều BUY và SELL cùng xuất hiện hoặc xung đột cấu trúc trên cùng nến đóng — đứng ngoài an toàn.",
                "closedM15Time": int(candle_ts),
            },
        )

    if mode == "AUTO_REGIME":
        if market_regime == "TREND_UP":
            valid_candidates = [c for c in valid_candidates if c["side"] == "BUY"]
        elif market_regime == "TREND_DOWN":
            valid_candidates = [c for c in valid_candidates if c["side"] == "SELL"]

    # Step 5: Pick the best valid signal or return explicit NO_TRADE / WAIT_PULLBACK
    if valid_candidates:
        valid_candidates.sort(key=lambda c: (c.get("setupScore", 0), c.get("netRewardRisk", 0.0)), reverse=True)
        best = valid_candidates[0]
        best["requestedMode"] = mode
        best["preferredSide"] = best["side"]
        best["marketRegime"] = market_regime
        best["regimeDetails"] = regime_info
        return best

    if obstacle_rejections:
        obs = obstacle_rejections[0]
        return wait(
            obs["reason"],
            status="NO_TRADE",
            extra={
                "subStatus": "NEAR_OBSTACLE_INSUFFICIENT_RR",
                "requestedMode": mode,
                "marketRegime": market_regime,
                "preferredSide": obs["side"],
                "nearestObstacle": obs.get("nearestObstacle"),
                "netRewardRisk": obs.get("netRewardRisk"),
                "requiredRewardRisk": obs.get("requiredRewardRisk"),
                "h4Bias": h4bias,
                "h1Bias": h1bias,
                "m15Bias": m15bias,
                "waitReasonVi": obs.get("waitReasonVi") or obs["reason"],
                "closedM15Time": int(candle_ts),
            },
        )

    if pullback_candidates:
        pb = dict(pullback_candidates[0])
        pb["pullbackState"] = {
            "side": pb.get("preferredSide") or pb.get("side"),
            "patternName": pb.get("patternName"),
            "structuralDistance": pb.get("structuralDistance"),
            "createdAtTs": int(candle_ts),
            "expiresAtTs": int(candle_ts) + WAIT_PULLBACK_MAX_AGE_MS,
            "maxPullbackAgeMs": WAIT_PULLBACK_MAX_AGE_MS,
        }
        return pb

    sell_votes = sum(1 for b in (h4bias, h1bias, m15bias) if b == "SELL")
    buy_votes = sum(1 for b in (h4bias, h1bias, m15bias) if b == "BUY")
    if sell_votes > buy_votes and sell_votes >= 2:
        pref_side = "SELL"
    elif buy_votes > sell_votes and buy_votes >= 2:
        pref_side = "BUY"
    elif market_regime in ("RANGE", "TRANSITION", "UNKNOWN"):
        pref_side = "NEUTRAL"
    else:
        closes_m15 = [b[3] for b in m15]
        fast_m15, slow_m15 = ema(closes_m15, 10), ema(closes_m15, 25)
        if fast_m15 is not None and slow_m15 is not None and abs(fast_m15 - slow_m15) > 0.15 * vol:
            pref_side = "SELL" if fast_m15 < slow_m15 else "BUY"
        else:
            pref_side = "NEUTRAL"

    if pref_side == "NEUTRAL":
        res = wait(
            f"NO_TRADE: Market regime is {market_regime} ({regime_info.get('reason', 'neutral/mixed structure')}); standing aside",
            status="NO_TRADE",
        )
        res["requestedMode"] = mode
        res["marketRegime"] = market_regime
        res["preferredSide"] = "NEUTRAL"
        res["h4Bias"] = h4bias
        res["h1Bias"] = h1bias
        res["m15Bias"] = m15bias
        res["waitReasonVi"] = (
            f"Trạng thái thị trường: {market_regime} (H4:{h4bias}, H1:{h1bias}, M15:{m15bias}) — "
            f"Cấu trúc trung tính/chuyển tiếp, đứng ngoài (NO_TRADE), không ép vào lệnh BUY/SELL."
        )
        res["closedM15Time"] = int(candle_ts)
        return res

    m5_ok = _m5_confirm(m5, pref_side)
    body_ratio = abs(last[3] - last[0]) / max(0.01, last[1] - last[2])
    dir_ok = (last[3] < last[0]) if pref_side == "SELL" else (last[3] > last[0])
    candle_ok = _engulfing(prev, last, pref_side) or (dir_ok and body_ratio >= 0.45)
    sweep_ok = _sweep(m15[:-1], last, pref_side, vol)
    ref_m5 = min(b[2] for b in m5[-8:]) if pref_side == "BUY" else max(b[1] for b in m5[-8:])
    exec_price = ask if pref_side == "BUY" else bid
    raw_m5_dist = _raw_stop_distance(pref_side, exec_price, ref_m5, vol)
    stop_ok = _stop_price(pref_side, exec_price, ref_m5, vol) is not None

    missing_parts = []
    if not (h4bias == pref_side and h1bias == pref_side and m15bias == pref_side) and not sweep_ok:
        missing_parts.append(f"đa khung chưa đồng pha hoàn toàn (H4:{h4bias}, H1:{h1bias}, M15:{m15bias})")
    if not candle_ok and not sweep_ok:
        missing_parts.append(
            f"nến M15 vừa đóng chưa tạo Nhấn chìm {pref_side} (thân {int(body_ratio * 100)}% < 45%) hoặc chưa Quét đỉnh/đáy 8 nến rút râu"
        )
    if not m5_ok:
        missing_parts.append(f"nến M5 vừa đóng chưa xác nhận cùng chiều {pref_side}")
    if not stop_ok:
        missing_parts.append(
            f"khoảng cách đỉnh/đáy 8 nến M5 ({raw_m5_dist or 0:.2f} giá) đang ngoài biên SL cấu trúc 6–8 giá (WAIT_PULLBACK)"
        )

    wait_status = (
        "WAIT_PULLBACK"
        if (not stop_ok and raw_m5_dist is not None and raw_m5_dist > MAX_STRUCTURAL_SL_DIST)
        else "NO_TRADE"
    )
    wait_reason = (
        f"WAIT_PULLBACK: Structural SL distance ({raw_m5_dist:.2f} USD/oz) exceeds {MAX_STRUCTURAL_SL_DIST:.1f} USD/oz cap"
        if wait_status == "WAIT_PULLBACK"
        else f"NO_TRADE ({market_regime}): No completed-bar setup with valid structural SL (6-8 USD/oz) and net R:R"
    )
    wait_vi = (
        f"Trạng thái {market_regime} (Theo dõi {pref_side}) — Đang đợi: " + "; ".join(missing_parts) + "."
        if missing_parts
        else f"Trạng thái {market_regime} (Theo dõi {pref_side}) — Đang đợi đóng nến M15 tiếp theo thỏa R:R ròng >= 1.6."
    )
    res = wait(wait_reason, status=wait_status)
    res["requestedMode"] = mode
    res["marketRegime"] = market_regime
    res["preferredSide"] = pref_side
    res["waitReasonVi"] = wait_vi
    res["h4Bias"] = h4bias
    res["h1Bias"] = h1bias
    res["m15Bias"] = m15bias
    res["closedM15Time"] = int(candle_ts)
    if raw_m5_dist is not None:
        res["rawStructuralSlDistance"] = round(raw_m5_dist, 2)
    return res


def find_confirmed_m5_swing(side, confirmed_m5):
    """Identify a confirmed M5 structural swing low (BUY) or swing high (SELL)
    using only closed M5 candles.
    - Prefers a confirmed 3-bar pivot (local low/high followed by a confirming close).
    - Falls back to the 5-bar confirmed staircase base when structure is advancing cleanly.
    """
    if not confirmed_m5 or len(confirmed_m5) < 5:
        return None
    window = confirmed_m5[-8:] if len(confirmed_m5) >= 8 else confirmed_m5[-5:]
    last_close = float(window[-1][3])
    if side == "BUY":
        pivots = []
        for i in range(1, len(window) - 1):
            low_i = float(window[i][2])
            if low_i <= float(window[i - 1][2]) and low_i <= float(window[i + 1][2]) and last_close > low_i:
                pivots.append(low_i)
        if pivots:
            return pivots[-1]
        recent5 = confirmed_m5[-5:]
        if float(recent5[-1][2]) >= float(recent5[0][2]) and last_close > float(recent5[0][2]):
            return min(float(b[2]) for b in recent5)
        return None
    else:
        pivots = []
        for i in range(1, len(window) - 1):
            high_i = float(window[i][1])
            if high_i >= float(window[i - 1][1]) and high_i >= float(window[i + 1][1]) and last_close < high_i:
                pivots.append(high_i)
        if pivots:
            return pivots[-1]
        recent5 = confirmed_m5[-5:]
        if float(recent5[-1][1]) <= float(recent5[0][1]) and last_close < float(recent5[0][1]):
            return max(float(b[1]) for b in recent5)
        return None


def trail_stop(side, entry, current, prior_sl, confirmed_m5, peak, buffer=0.35, min_gap=1.2):
    """Evaluate confirmed M5 structure BOTH before BE (to reduce initial risk)
    and after BE (to lock profit).
    Strictly monotonic: never widens SL, never crosses current executable price.
    """
    if not confirmed_m5 or len(confirmed_m5) < 5:
        return None
    swing = find_confirmed_m5_swing(side, confirmed_m5)
    if swing is None:
        return None
    if side == "BUY":
        candidate = round(swing - buffer, 2)
        if candidate <= 0 or candidate >= current - min_gap:
            return None
        return candidate if candidate > prior_sl + 0.15 else None
    candidate = round(swing + buffer, 2)
    if candidate <= current + min_gap:
        return None
    return candidate if prior_sl > 0 and candidate < prior_sl - 0.15 else None


def is_m15_fast_move(confirmed_m15, entry, peak, side, initial_r=6.8, spike_dist=10.0):
    """Detect a strong M15 expansion or favorable excursion sufficient to engage
    the 10 USD/oz peak-to-SL protective lock.
    """
    buy = str(side).upper() == "BUY"
    peak_gain = (float(peak) - float(entry)) if buy else (float(entry) - float(peak))
    if peak_gain >= float(spike_dist):
        return True
    if not confirmed_m15:
        return False
    last_bar = confirmed_m15[-1]
    op, hi, lo, cl = float(last_bar[0]), float(last_bar[1]), float(last_bar[2]), float(last_bar[3])
    rng = hi - lo
    body = (cl - op) if buy else (op - cl)
    m15_atr = atr(confirmed_m15) if len(confirmed_m15) >= 15 else None
    atr_thresh = max(5.5, 1.35 * m15_atr) if (m15_atr is not None and m15_atr > 0) else 5.5
    if (rng >= atr_thresh or body >= 4.0) and peak_gain >= max(4.0, float(initial_r) * 0.6):
        return True
    return False


def peak_profit_stop(side, entry, current, prior_sl, peak, distance=10.0, min_gap=0.8):
    """Lock SL at peak - distance (BUY) or peak + distance (SELL) monotonically."""
    if distance <= 0:
        return None
    if side == "BUY":
        candidate = round(peak - distance, 2)
        return candidate if candidate > 0 and candidate < current - min_gap and candidate > prior_sl + 0.15 else None
    candidate = round(peak + distance, 2)
    return candidate if candidate > current + min_gap and prior_sl > 0 and candidate < prior_sl - 0.15 else None


def evaluate_position_management_step(
    side,
    entry,
    current_price,
    current_sl,
    current_tp,
    initial_r,
    favorable_extreme,
    confirmed_m5,
    confirmed_m15,
    strategy_mode="BOT_1_TREND",
    config=None,
):
    """Unified Position Management Function shared 100% between Live Trading and Backtest (Section 2):
    - Never recalculates initialR from a moved SL.
    - Uses only closed M5/M15 candles (`confirmed_m5`, `confirmed_m15`).
    - Break-Even (BE) triggers strictly at 1R (`initial_r * beTriggerRMultiple`, default 1.0R); NEVER uses DCA stepDistance (4.5).
    - Explicitly accounts for round-trip cost (`roundTripCostPts`) vs BE buffer (`beBufferPts`) and labels `BE_NET` vs `BE_NOMINAL`.
    - Evaluates confirmed M5 structural trailing BOTH before BE and after BE.
    - Evaluates favorable extreme protection (`favorable_extreme - 10` for BUY, `favorable_extreme + 10` for SELL).
    - Evaluates all valid SL candidates and selects the most protective monotonic SL that respects broker stop gap.
    - Keeps existing valid TP unchanged (`newTp = current_tp`); never partial-closes or closes on signal/regime change.
    """
    cfg = config or {}
    side_up = str(side).upper()
    buy = side_up == "BUY"
    entry_f = float(entry)
    cur_f = float(current_price)
    sl_f = float(current_sl or 0.0)
    tp_f = float(current_tp or 0.0)

    persisted_r = float(initial_r or 0.0)
    if persisted_r <= 0.01:
        persisted_r = round(abs(entry_f - sl_f), 4) if sl_f > 0 else 6.8

    prev_extreme = float(favorable_extreme if favorable_extreme is not None else entry_f)
    updated_extreme = max(entry_f, prev_extreme, cur_f) if buy else min(entry_f, prev_extreme, cur_f)

    favorable_now = (cur_f - entry_f) if buy else (entry_f - cur_f)
    peak_gain = (updated_extreme - entry_f) if buy else (entry_f - updated_extreme)

    be_r_mult = max(0.5, float(cfg.get("beTriggerRMultiple") or 1.0))
    be_trigger_pts = round(persisted_r * be_r_mult, 4)
    be_enabled = bool(cfg.get("beAtOneR", True))

    round_trip_cost_pts = max(0.0, float(cfg.get("roundTripCostPts") if cfg.get("roundTripCostPts") is not None else DEFAULT_ROUND_TRIP_COST_PTS))
    be_cost_source = str(cfg.get("beCostSource") or ("BROKER_ACTUAL_CONFIGURED" if cfg.get("beCostVerified") else "ESTIMATED_DEFAULT"))
    be_cost_unit = "USD_PER_OZ"
    raw_be_buffer = float(cfg.get("beBufferPts") if cfg.get("beBufferPts") is not None else 0.25)
    compensate_cost = bool(cfg.get("beCompensateCost", True))
    be_offset_pts = max(raw_be_buffer, round_trip_cost_pts) if compensate_cost else raw_be_buffer
    be_covers_full_cost = be_offset_pts >= round_trip_cost_pts - 1e-6
    if be_covers_full_cost and be_cost_source == "BROKER_ACTUAL_CONFIGURED":
        be_cost_label = "BE_NET (Hòa vốn ròng đã bù phí thực tế USD/oz)"
    elif be_covers_full_cost:
        be_cost_label = "BE_ESTIMATED_NET (Hòa vốn ước tính theo phí giả định USD/oz)"
    else:
        be_cost_label = "BE_NOMINAL (Dời sát Entry, chưa bù đủ phí)"

    at_be_before = (sl_f >= entry_f if buy else (0 < sl_f <= entry_f))
    is_sideway = str(strategy_mode or "").upper() == "BOT_2_SIDEWAY"
    enable_m5_trail = bool(cfg.get("sidewayEnableM5Trail", True)) if is_sideway else bool(cfg.get("enableM5StructuralTrail", True))
    enable_peak_lock = bool(cfg.get("sidewayEnablePeakLock", False)) if is_sideway else bool(cfg.get("enablePeakLock", True))
    spike_dist = max(5.0, float(cfg.get("m15SpikeTrailDist") or 10.0))
    min_broker_gap = max(0.20, float(cfg.get("minBrokerStopGap") or 0.80))

    candidates = []

    if be_enabled and not at_be_before and max(favorable_now, peak_gain) >= be_trigger_pts and favorable_now >= 1.0:
        be_cand = round(entry_f + (be_offset_pts if buy else -be_offset_pts), 2)
        gap_ok = (be_cand <= cur_f - min_broker_gap) if buy else (be_cand >= cur_f + min_broker_gap)
        mono_ok = (be_cand > sl_f + 0.15) if buy else (sl_f <= 0 or be_cand < sl_f - 0.15)
        if gap_ok and mono_ok:
            candidates.append({
                "sl": be_cand,
                "code": "BE_1R",
                "reason": f"Reached 1R (+{be_trigger_pts:.2f} USD/oz); {be_cost_label} -> SL {be_cand:.2f}",
            })

    if enable_m5_trail and confirmed_m5 and len(confirmed_m5) >= 5:
        m5_cand = trail_stop(
            side_up,
            entry_f,
            cur_f,
            sl_f,
            confirmed_m5,
            updated_extreme,
            buffer=0.35,
            min_gap=max(1.2, min_broker_gap),
        )
        if m5_cand is not None:
            phase = "Post-BE profit lock" if at_be_before else "Pre-BE risk reduction"
            candidates.append({
                "sl": m5_cand,
                "code": "M5_STRUCTURAL_TRAIL_POST_BE" if at_be_before else "M5_STRUCTURAL_TRAIL_PRE_BE",
                "reason": f"Confirmed M5 swing trailing ({phase}) -> SL {m5_cand:.2f}",
            })

    if enable_peak_lock and is_m15_fast_move(confirmed_m15, entry_f, updated_extreme, side_up, persisted_r, spike_dist):
        pk_cand = peak_profit_stop(
            side_up,
            entry_f,
            cur_f,
            sl_f,
            updated_extreme,
            distance=spike_dist,
            min_gap=max(0.8, min_broker_gap),
        )
        if pk_cand is not None:
            candidates.append({
                "sl": pk_cand,
                "code": "EXTREME_10_USD_LOCK",
                "reason": f"M15 fast-move extreme lock ({spike_dist:.1f} USD/oz from extreme {updated_extreme:.2f}) -> SL {pk_cand:.2f}",
            })

    if not candidates:
        return {
            "shouldModifySl": False,
            "newSl": round(sl_f, 2),
            "newTp": round(tp_f, 2),
            "tpModified": False,
            "actionCode": "HOLD",
            "reason": "No monotonic SL tightening candidate valid at current price",
            "initialR": persisted_r,
            "beTriggerPts": be_trigger_pts,
            "beCoversFullCost": be_covers_full_cost,
        "beCostSource": be_cost_source,
        "beCostUnit": be_cost_unit,
        "beOffsetPts": round(be_offset_pts, 4),
            "favorableExtreme": round(updated_extreme, 2),
            "atBeAfter": at_be_before,
            "preBeTrailed": bool(not at_be_before and sl_f > 0 and abs(entry_f - sl_f) < persisted_r - 0.15),
            "candidatesEvaluated": [],
        }

    best = max(candidates, key=lambda c: c["sl"]) if buy else min(candidates, key=lambda c: c["sl"])
    best_sl = round(float(best["sl"]), 2)
    at_be_after = (best_sl >= entry_f) if buy else (0 < best_sl <= entry_f)

    return {
        "shouldModifySl": True,
        "newSl": best_sl,
        "newTp": round(tp_f, 2),
        "tpModified": False,
        "actionCode": best["code"],
        "reason": best["reason"],
        "initialR": persisted_r,
        "beTriggerPts": be_trigger_pts,
        "beCoversFullCost": be_covers_full_cost,
        "favorableExtreme": round(updated_extreme, 2),
        "atBeAfter": at_be_after,
        "preBeTrailed": bool(not at_be_after),
        "candidatesEvaluated": candidates,
    }
