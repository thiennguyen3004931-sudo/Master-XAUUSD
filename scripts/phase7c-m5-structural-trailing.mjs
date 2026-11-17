import {
  stopStrictlyTightens,
  structuralStopWithBuffer,
  tightestKnownStop,
} from "./phase7c-stop-monotonicity.mjs";

function normalizeSide(side) {
  const value = String(side ?? "").trim().toUpperCase();
  return value === "BUY" || value === "SELL" ? value : null;
}

function roundPrice(value, digits) {
  const safeDigits = Math.max(0, Math.min(10, Math.trunc(Number(digits) || 0)));
  return Number(Number(value).toFixed(safeDigits));
}

export function latestConfirmedM5Structure({
  side,
  bars,
  afterTimestamp = 0,
  atOrBefore = Number.POSITIVE_INFINITY,
}) {
  const normalizedSide = normalizeSide(side);
  if (!normalizedSide || !Array.isArray(bars) || bars.length < 3) return null;

  const after = Number(afterTimestamp);
  const cutoff = Number(atOrBefore);
  if (!Number.isFinite(after) || !(Number.isFinite(cutoff) || cutoff === Number.POSITIVE_INFINITY)) return null;

  let latest = null;
  for (let index = 1; index < bars.length - 1; index += 1) {
    const left = bars[index - 1];
    const middle = bars[index];
    const right = bars[index + 1];
    const leftLow = Number(left?.low);
    const leftHigh = Number(left?.high);
    const middleLow = Number(middle?.low);
    const middleHigh = Number(middle?.high);
    const rightLow = Number(right?.low);
    const rightHigh = Number(right?.high);
    const middleCloseTime = Number(middle?.closeTime);
    const rightCloseTime = Number(right?.closeTime);

    if (
      ![leftLow, leftHigh, middleLow, middleHigh, rightLow, rightHigh, middleCloseTime, rightCloseTime].every(Number.isFinite) ||
      rightCloseTime > cutoff ||
      rightCloseTime <= after
    ) {
      continue;
    }

    if (
      normalizedSide === "BUY" &&
      middleLow < leftLow &&
      middleLow <= rightLow
    ) {
      latest = {
        price: middleLow,
        confirmedAt: rightCloseTime,
        pivotCloseTime: middleCloseTime,
      };
    }

    if (
      normalizedSide === "SELL" &&
      middleHigh > leftHigh &&
      middleHigh >= rightHigh
    ) {
      latest = {
        price: middleHigh,
        confirmedAt: rightCloseTime,
        pivotCloseTime: middleCloseTime,
      };
    }
  }

  return latest;
}

export function evaluateM5StructuralTrail({
  side,
  bars,
  afterTimestamp = 0,
  atOrBefore = Number.POSITIVE_INFINITY,
  currentStop = 0,
  lastStructuralStop = 0,
  bid,
  ask,
  digits = 2,
  point = 0,
  stopsLevelTicks = 0,
  freezeLevelTicks = 0,
}) {
  const normalizedSide = normalizeSide(side);
  if (!normalizedSide) return { allowed: false, reason: "INVALID_SIDE" };

  const structure = latestConfirmedM5Structure({
    side: normalizedSide,
    bars,
    afterTimestamp,
    atOrBefore,
  });
  if (!structure) return { allowed: false, reason: "NO_CONFIRMED_STRUCTURE" };

  const buffered = structuralStopWithBuffer(normalizedSide, structure.price);
  const candidate = roundPrice(buffered, digits);
  const baseline = tightestKnownStop(
    normalizedSide,
    Number(currentStop),
    Number(lastStructuralStop),
  );

  if (!stopStrictlyTightens(normalizedSide, baseline, candidate)) {
    return {
      allowed: false,
      reason: "NOT_STRICTLY_TIGHTER",
      stopLoss: candidate,
      structurePrice: structure.price,
      confirmedAt: structure.confirmedAt,
      pivotCloseTime: structure.pivotCloseTime,
      baseline,
    };
  }

  const marketBid = Number(bid);
  const marketAsk = Number(ask);
  const pricePoint = Number(point);
  const stopTicks = Number(stopsLevelTicks);
  const freezeTicks = Number(freezeLevelTicks);
  if (
    !Number.isFinite(marketBid) ||
    !Number.isFinite(marketAsk) ||
    !(pricePoint > 0) ||
    !Number.isFinite(stopTicks) ||
    !Number.isFinite(freezeTicks)
  ) {
    return { allowed: false, reason: "INVALID_MARKET_OR_SPEC" };
  }

  const minimumGap = Math.max(0, stopTicks, freezeTicks) * pricePoint;
  const validAgainstMarket = normalizedSide === "BUY"
    ? candidate < marketBid - minimumGap
    : candidate > marketAsk + minimumGap;

  if (!validAgainstMarket) {
    return {
      allowed: false,
      reason: "BROKER_STOP_OR_FREEZE_GAP",
      stopLoss: candidate,
      structurePrice: structure.price,
      confirmedAt: structure.confirmedAt,
      pivotCloseTime: structure.pivotCloseTime,
      baseline,
      minimumGap,
    };
  }

  return {
    allowed: true,
    reason: "M5_CONFIRMED_STRUCTURE_TIGHTEN",
    stopLoss: candidate,
    structurePrice: structure.price,
    confirmedAt: structure.confirmedAt,
    pivotCloseTime: structure.pivotCloseTime,
    baseline,
    minimumGap,
  };
}
