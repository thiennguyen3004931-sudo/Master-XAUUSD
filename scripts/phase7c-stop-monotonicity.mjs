const EPSILON = 1e-9;

export const STRUCTURAL_STOP_BUFFER_PRICE = 1;

function normalizeSide(side) {
  const normalized = String(side ?? "").trim().toUpperCase();
  return normalized === "BUY" || normalized === "SELL" ? normalized : null;
}

export function structuralStopWithBuffer(
  side,
  structuralStop,
  buffer = STRUCTURAL_STOP_BUFFER_PRICE,
) {
  const normalizedSide = normalizeSide(side);
  const stop = Number(structuralStop);
  const distance = Number(buffer);
  if (
    !normalizedSide ||
    !(stop > 0) ||
    !Number.isFinite(distance) ||
    distance < 0
  ) {
    return 0;
  }

  const buffered = normalizedSide === "BUY"
    ? stop - distance
    : stop + distance;
  return Number.isFinite(buffered) && buffered > 0 ? buffered : 0;
}

export function stopStrictlyTightens(side, currentStop, candidateStop) {
  const normalizedSide = normalizeSide(side);
  const current = Number(currentStop);
  const candidate = Number(candidateStop);
  if (!normalizedSide || !(candidate > 0)) return false;
  if (!(current > 0)) return true;
  return normalizedSide === "BUY"
    ? candidate > current + EPSILON
    : candidate < current - EPSILON;
}

export function stopIsAtLeastAsTight(side, currentStop, requiredStop) {
  const normalizedSide = normalizeSide(side);
  const current = Number(currentStop);
  const required = Number(requiredStop);
  if (!normalizedSide || !(current > 0) || !(required > 0)) return false;
  return normalizedSide === "BUY"
    ? current >= required - EPSILON
    : current <= required + EPSILON;
}

export function tightestKnownStop(side, ...stops) {
  const normalizedSide = normalizeSide(side);
  if (!normalizedSide) return 0;

  const validStops = stops
    .map((stop) => Number(stop))
    .filter((stop) => Number.isFinite(stop) && stop > 0);

  if (validStops.length === 0) return 0;
  return normalizedSide === "BUY"
    ? Math.max(...validStops)
    : Math.min(...validStops);
}
