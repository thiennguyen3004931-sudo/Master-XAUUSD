import { structuralStopWithBuffer } from "./phase7c-stop-monotonicity.mjs";

const MIN_INITIAL_STOP_DISTANCE = 6;
const MAX_INITIAL_STOP_DISTANCE = 10;

export function resolveSidewayPermission(activeMode, recommendedMode) {
  const active = String(activeMode ?? "PAUSE").trim().toUpperCase();
  const recommended = String(recommendedMode ?? "PAUSE").trim().toUpperCase();

  if (active === "SIDEWAY") {
    return { allowed: true, reason: "MANUAL_SIDEWAY_MODE", activeMode: active, recommendedMode: recommended };
  }
  if (active === "AUTO") {
    return {
      allowed: recommended === "SIDEWAY",
      reason: recommended === "SIDEWAY" ? "AUTO_REGIME_ALLOWS_SIDEWAY" : `AUTO_REGIME_RECOMMENDS_${recommended}`,
      activeMode: active,
      recommendedMode: recommended,
    };
  }
  if (active === "TREND") {
    return { allowed: false, reason: "TREND_MODE_BLOCKS_SIDEWAY_ENTRY", activeMode: active, recommendedMode: recommended };
  }
  if (active === "PAUSE") {
    return { allowed: false, reason: "PAUSE_MODE_BLOCKS_NEW_ENTRY", activeMode: active, recommendedMode: recommended };
  }
  return { allowed: false, reason: "INVALID_MODE_FAIL_CLOSED", activeMode: active, recommendedMode: recommended };
}

export function chooseRangeSide(range, bid, ask) {
  if (!range || !Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  const demandLow = Number(range.demand?.low);
  const lower = Number(range.demand?.high);
  const upper = Number(range.supply?.low);
  const supplyHigh = Number(range.supply?.high);
  if (![demandLow, lower, upper, supplyHigh].every(Number.isFinite) || upper <= lower || lower < demandLow || supplyHigh < upper) return null;

  const mid = (bid + ask) / 2;
  if (mid < demandLow || mid > supplyHigh) return null;

  const position = clamp((mid - lower) / (upper - lower), 0, 1);
  const buyNear = ask <= lower || position <= 0.30;
  const sellNear = bid >= upper || position >= 0.70;

  if (buyNear && sellNear) return position <= 0.5 ? "BUY" : "SELL";
  if (buyNear) return "BUY";
  if (sellNear) return "SELL";
  return null;
}

export function detectM5Confirmation(bars, side) {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  const current = bars.at(-1);
  const previous = bars.at(-2);
  if (!validBar(current) || !validBar(previous)) return null;

  const currentBody = Math.abs(current.close - current.open);
  const currentRange = Math.max(1e-9, current.high - current.low);
  const lowerWick = Math.min(current.open, current.close) - current.low;
  const upperWick = current.high - Math.max(current.open, current.close);

  if (side === "BUY") {
    const engulfing = previous.close < previous.open && current.close > current.open &&
      current.open <= previous.close + 1e-9 && current.close >= previous.open - 1e-9;
    const rejection = current.close > current.open && lowerWick >= Math.max(currentBody * 1.2, currentRange * 0.25) &&
      current.close >= current.low + currentRange * 0.60;
    if (engulfing) return { pattern: "BULLISH_ENGULFING", closeTime: Number(current.closeTime), triggerPrice: current.close };
    if (rejection) return { pattern: "BULLISH_REJECTION", closeTime: Number(current.closeTime), triggerPrice: current.close };
    return null;
  }

  if (side === "SELL") {
    const engulfing = previous.close > previous.open && current.close < current.open &&
      current.open >= previous.close - 1e-9 && current.close <= previous.open + 1e-9;
    const rejection = current.close < current.open && upperWick >= Math.max(currentBody * 1.2, currentRange * 0.25) &&
      current.close <= current.low + currentRange * 0.40;
    if (engulfing) return { pattern: "BEARISH_ENGULFING", closeTime: Number(current.closeTime), triggerPrice: current.close };
    if (rejection) return { pattern: "BEARISH_REJECTION", closeTime: Number(current.closeTime), triggerPrice: current.close };
  }
  return null;
}

export function detectM5ConfirmationWithinBars(bars, side, carryBars = 0) {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  const normalizedCarryBars = Math.max(0, Math.min(2, Math.trunc(Number(carryBars) || 0)));
  const evaluationCloseTime = Number(bars.at(-1)?.closeTime);

  for (let ageBars = 0; ageBars <= normalizedCarryBars; ageBars += 1) {
    const currentIndex = bars.length - 1 - ageBars;
    if (currentIndex < 1) break;
    const candidateCloseTime = Number(bars[currentIndex]?.closeTime);
    if (
      ageBars > 0 &&
      (
        !Number.isFinite(evaluationCloseTime) ||
        !Number.isFinite(candidateCloseTime) ||
        evaluationCloseTime <= candidateCloseTime ||
        evaluationCloseTime - candidateCloseTime > ageBars * 5 * 60_000 + 1_000
      )
    ) {
      continue;
    }

    const candidate = detectM5Confirmation(
      [bars[currentIndex - 1], bars[currentIndex]],
      side,
    );
    if (candidate) {
      return {
        ...candidate,
        ageBars,
        evaluationCloseTime,
      };
    }
  }
  return null;
}

export function estimateVolumePoc(bars, lower, upper, binCount = 24) {
  if (!Array.isArray(bars) || !Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) return null;
  const count = Math.max(8, Math.min(64, Math.trunc(binCount)));
  const bins = Array.from({ length: count }, () => 0);
  const width = (upper - lower) / count;

  for (const bar of bars) {
    if (!validBar(bar)) continue;
    const price = (Number(bar.high) + Number(bar.low) + Number(bar.close)) / 3;
    if (price < lower || price > upper) continue;
    const volume = Math.max(1, Number(bar.volume ?? bar.tickVolume ?? 1));
    const index = Math.min(count - 1, Math.max(0, Math.floor((price - lower) / width)));
    bins[index] += Number.isFinite(volume) ? volume : 1;
  }

  let bestIndex = -1;
  let bestVolume = 0;
  for (let index = 0; index < bins.length; index += 1) {
    if (bins[index] > bestVolume) {
      bestVolume = bins[index];
      bestIndex = index;
    }
  }
  if (bestIndex < 0 || bestVolume <= 0) return null;
  return lower + (bestIndex + 0.5) * width;
}

export function buildSidewayPlan({ side, bid, ask, range, atr, point, stopsLevelTicks = 0, digits = 2 }) {
  if (!range || (side !== "BUY" && side !== "SELL")) return { accepted: false, reason: "INVALID_INPUT" };
  const demandLow = Number(range.demand?.low);
  const demandHigh = Number(range.demand?.high);
  const supplyLow = Number(range.supply?.low);
  const supplyHigh = Number(range.supply?.high);
  const values = [bid, ask, demandLow, demandHigh, supplyLow, supplyHigh, atr, point];
  if (!values.every(Number.isFinite) || supplyLow <= demandHigh || point <= 0 || atr <= 0) {
    return { accepted: false, reason: "INVALID_RANGE_OR_MARKET" };
  }

  const entry = side === "BUY" ? ask : bid;
  const brokerGap = Math.max(0, Number(stopsLevelTicks) || 0) * point;
  const buffer = Math.max(atr * 0.25, brokerGap, point * 20);
  const existingStructuralStopLoss = side === "BUY"
    ? demandLow - buffer
    : supplyHigh + buffer;
  const structuralStopLoss = structuralStopWithBuffer(
    side,
    existingStructuralStopLoss,
  );
  const structuralStopDistance = Math.abs(entry - structuralStopLoss);
  if (!(structuralStopDistance > 0)) {
    return { accepted: false, reason: "STOP_DISTANCE_INVALID", structuralStopDistance };
  }

  // Project-wide initial stop policy: first keep the stop 1.0 price unit outside
  // the previously-derived structural stop, then evaluate the canonical 6-10
  // price-unit window. If the buffered structure requires more than 10, fail
  // closed and wait for a later pullback/confirmation.
  if (structuralStopDistance > MAX_INITIAL_STOP_DISTANCE + 1e-9) {
    return {
      accepted: false,
      reason: "WAIT_PULLBACK_STOP_GT_10",
      structuralStopLoss: round(structuralStopLoss, digits),
      structuralStopDistance: round(structuralStopDistance, Math.max(digits, 5)),
      maxInitialStopDistance: MAX_INITIAL_STOP_DISTANCE,
    };
  }

  const stopDistance = Math.max(MIN_INITIAL_STOP_DISTANCE, structuralStopDistance);
  const stopLoss = side === "BUY" ? entry - stopDistance : entry + stopDistance;

  const finalTarget = side === "BUY" ? supplyLow : demandHigh;
  const finalDistance = side === "BUY" ? finalTarget - entry : entry - finalTarget;
  if (!(finalDistance > 0)) return { accepted: false, reason: "FINAL_TARGET_NOT_FAVORABLE" };
  if (finalDistance <= 10 + 1e-9) {
    return { accepted: false, reason: "FINAL_TARGET_BEFORE_PLUS_10", finalDistance };
  }

  const tp1 = side === "BUY" ? entry + 10 : entry - 10;

  const rewardRisk = finalDistance / stopDistance;
  if (rewardRisk < 1.2) {
    return { accepted: false, reason: "FINAL_RR_BELOW_1_2", rewardRisk };
  }

  return {
    accepted: true,
    reason: "SIDEWAY_PLAN_ACCEPTED",
    side,
    entry: round(entry, digits),
    stopLoss: round(stopLoss, digits),
    stopDistance: round(stopDistance, Math.max(digits, 5)),
    structuralStopLoss: round(structuralStopLoss, digits),
    structuralStopDistance: round(structuralStopDistance, Math.max(digits, 5)),
    stopPolicy: structuralStopDistance < MIN_INITIAL_STOP_DISTANCE - 1e-9
      ? "WIDENED_TO_MIN_6"
      : "STRUCTURAL_6_TO_10",
    tp1: round(tp1, digits),
    tp1Kind: "FIXED_PLUS_10",
    takeProfit: round(finalTarget, digits),
    rewardRisk: round(rewardRisk, 3),
    range: {
      demandLow: round(demandLow, digits),
      demandHigh: round(demandHigh, digits),
      supplyLow: round(supplyLow, digits),
      supplyHigh: round(supplyHigh, digits),
    },
  };
}

export function targetReached(side, marketPrice, target) {
  if (![marketPrice, target].every(Number.isFinite)) return false;
  return side === "BUY" ? marketPrice >= target : marketPrice <= target;
}

export function normalizeVolume(value, step, digits = 8) {
  if (!(value > 0) || !(step > 0)) return 0;
  const units = Math.floor((value + 1e-12) / step);
  return round(units * step, digits);
}

export function oneThirdPartialVolume(initialVolume, currentVolume, minVolume, step) {
  if (!(initialVolume > 0) || !(currentVolume > 0) || !(minVolume > 0) || !(step > 0)) return 0;
  const rawThird = initialVolume / 3;
  const rawUnits = rawThird / step;
  if (Math.abs(rawUnits - Math.round(rawUnits)) > 1e-8) return 0;
  const desired = normalizeVolume(rawThird, step);
  if (Math.abs(desired - rawThird) > 1e-8 || desired < minVolume - 1e-9) return 0;
  const remaining = normalizeVolume(currentVolume - desired, step);
  if (remaining < minVolume - 1e-9) return 0;
  return desired;
}

export function matchPendingEntryPosition(pending, positions, spec, now = Date.now(), brokerClockOffsetMs = 0) {
  if (!pending || !Array.isArray(positions) || positions.length !== 1) {
    return { matched: false, reason: "PENDING_REQUIRES_EXACTLY_ONE_POSITION", position: null };
  }

  const position = positions[0];
  const step = Number(spec?.volumeStep);
  const point = Number(spec?.point);
  if (!(step > 0) || !(point > 0)) {
    return { matched: false, reason: "PENDING_BROKER_SPEC_INVALID", position: null };
  }

  const expectedSide = pending.side === "BUY" ? "LONG" : pending.side === "SELL" ? "SHORT" : null;
  if (!expectedSide || position?.side !== expectedSide) {
    return { matched: false, reason: "PENDING_SIDE_MISMATCH", position: null };
  }

  const volumeTolerance = step / 2 + 1e-9;
  if (Math.abs(Number(position.volume) - Number(pending.volume)) > volumeTolerance) {
    return { matched: false, reason: "PENDING_VOLUME_MISMATCH", position: null };
  }

  const priceTolerance = Math.max(point * 2, 1e-6);
  if (Math.abs(Number(position.stopLoss) - Number(pending.stopLoss)) > priceTolerance) {
    return { matched: false, reason: "PENDING_STOP_LOSS_MISMATCH", position: null };
  }
  if (Math.abs(Number(position.takeProfit) - Number(pending.tp2)) > priceTolerance) {
    return { matched: false, reason: "PENDING_TAKE_PROFIT_MISMATCH", position: null };
  }

  const createdAt = Number(pending.createdAt);
  const openedAtBroker = Number(position.openedAt);
  const offset = Number(brokerClockOffsetMs);
  const current = Number(now);
  if (![createdAt, openedAtBroker, offset, current].every(Number.isFinite)) {
    return { matched: false, reason: "PENDING_TIMESTAMP_INVALID", position: null };
  }

  const openedAt = openedAtBroker - offset;
  if (openedAt < createdAt - 120_000 || openedAt > current + 10_000) {
    return {
      matched: false,
      reason: "PENDING_OPEN_TIME_MISMATCH",
      position: null,
      openedAtBroker,
      openedAtNormalized: openedAt,
      brokerClockOffsetMs: offset,
    };
  }

  return {
    matched: true,
    reason: "PENDING_POSITION_MATCHED",
    position,
    openedAtBroker,
    openedAtNormalized: openedAt,
    brokerClockOffsetMs: offset,
  };
}

export function reconcileManagedBrokerState(managed, position, spec) {
  if (!managed || !position) {
    return { accepted: false, reason: "MANAGED_OR_POSITION_MISSING", managed, events: [] };
  }

  const step = Number(spec?.volumeStep);
  const minVolume = Number(spec?.minVolume);
  const point = Number(spec?.point);
  if (!(step > 0) || !(minVolume > 0) || !(point > 0)) {
    return { accepted: false, reason: "BROKER_SPEC_INVALID", managed, events: [] };
  }

  const next = { ...managed };
  const events = [];
  const expectedSide = next.side === "BUY" ? "LONG" : next.side === "SELL" ? "SHORT" : null;
  if (!expectedSide || position.side !== expectedSide) {
    return { accepted: false, reason: "MANAGED_SIDE_MISMATCH", managed: next, events };
  }

  const actualVolume = Number(position.volume);
  const expectedVolume = Number(next.expectedRemainingVolume);
  const volumeTolerance = step / 2 + 1e-9;
  if (Math.abs(actualVolume - expectedVolume) > volumeTolerance) {
    if (!next.partialApplied && actualVolume < expectedVolume) {
      const partialVolume = oneThirdPartialVolume(
        Number(next.initialVolume),
        expectedVolume,
        minVolume,
        step,
      );
      const expectedAfterPartial = normalizeVolume(expectedVolume - partialVolume, step);
      if (partialVolume > 0 && Math.abs(actualVolume - expectedAfterPartial) <= volumeTolerance) {
        next.partialApplied = true;
        next.expectedRemainingVolume = actualVolume;
        events.push({ type: "PLUS10_PARTIAL_RECOVERED_FROM_BROKER_VOLUME", actualVolume, partialVolume });
      } else {
        return {
          accepted: false,
          reason: "MANAGED_VOLUME_MISMATCH",
          managed: next,
          events,
          expectedVolume,
          actualVolume,
        };
      }
    } else {
      return {
        accepted: false,
        reason: "MANAGED_VOLUME_MISMATCH",
        managed: next,
        events,
        expectedVolume,
        actualVolume,
      };
    }
  }

  const stopLoss = Number(position.stopLoss);
  const entry = Number(next.entry);
  const priceTolerance = Math.max(point * 2, 1e-6);
  if (next.partialApplied && !next.breakEvenApplied && Number.isFinite(stopLoss) && Number.isFinite(entry) && Math.abs(stopLoss - entry) <= priceTolerance) {
    next.breakEvenApplied = true;
    events.push({ type: "BREAK_EVEN_RECOVERED_FROM_BROKER_STOP", stopLoss });
  }

  return { accepted: true, reason: "MANAGED_BROKER_STATE_RECONCILED", managed: next, events };
}

function validBar(bar) {
  return bar && [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
