function normalizeSide(side) {
  const normalized = String(side ?? "").trim().toUpperCase();
  if (normalized !== "BUY" && normalized !== "SELL") {
    throw new Error(`Fixed TP side must be BUY or SELL; actual=${side}`);
  }
  return normalized;
}

function finiteNumber(value, label) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    throw new Error(`${label} must be finite.`);
  }
  return normalized;
}

function positiveDistance(value) {
  const distance = finiteNumber(value, "Fixed TP distance");
  if (distance <= 0) {
    throw new Error("Fixed TP distance must be positive when enabled.");
  }
  return distance;
}

export function fixedTpTargetPrice(side, entry, distance) {
  const normalizedSide = normalizeSide(side);
  const normalizedEntry = finiteNumber(entry, "Fixed TP entry");
  const normalizedDistance = positiveDistance(distance);
  return normalizedSide === "BUY"
    ? normalizedEntry + normalizedDistance
    : normalizedEntry - normalizedDistance;
}

export function buildFixedTpSnapshot({ enabled, distance, side, entry }) {
  const normalizedEnabled = enabled === true;
  if (!normalizedEnabled) {
    return {
      enabled: false,
      distance: 0,
      targetPrice: null,
    };
  }
  const normalizedDistance = positiveDistance(distance);
  return {
    enabled: true,
    distance: normalizedDistance,
    targetPrice: fixedTpTargetPrice(side, entry, normalizedDistance),
  };
}

export function isFixedTpTriggered({ enabled = true, side, targetPrice, bid, ask }) {
  if (enabled !== true || targetPrice === null || targetPrice === undefined) return false;
  const normalizedSide = normalizeSide(side);
  const normalizedTarget = finiteNumber(targetPrice, "Fixed TP target price");
  if (normalizedSide === "BUY") {
    return finiteNumber(bid, "Fixed TP BUY bid") >= normalizedTarget;
  }
  return finiteNumber(ask, "Fixed TP SELL ask") <= normalizedTarget;
}

export function fixedTpCommandId(strategy, ticket) {
  const normalizedStrategy = String(strategy ?? "").trim().toLowerCase();
  if (!normalizedStrategy || !/^[a-z0-9_-]+$/.test(normalizedStrategy)) {
    throw new Error(`Fixed TP strategy is invalid; actual=${strategy}`);
  }
  const normalizedTicket = String(ticket ?? "").trim();
  if (!normalizedTicket || !/^[a-zA-Z0-9_-]+$/.test(normalizedTicket)) {
    throw new Error(`Fixed TP ticket is invalid; actual=${ticket}`);
  }
  return `phase7c-fixed-tp-${normalizedStrategy}-${normalizedTicket}`;
}
