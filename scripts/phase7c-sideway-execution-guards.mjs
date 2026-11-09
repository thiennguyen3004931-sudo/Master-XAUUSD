const HOUR_MS = 60 * 60_000;

export function inferBrokerClockOffset(brokerTimestamp, {
  systemTimestamp = Date.now(),
  maxOffsetHours = 14,
  residualToleranceMs = 5 * 60_000,
} = {}) {
  const broker = Number(brokerTimestamp);
  const system = Number(systemTimestamp);
  const maxHours = Math.max(0, Math.trunc(Number(maxOffsetHours)));
  const residualTolerance = Math.max(0, Number(residualToleranceMs));

  if (!Number.isFinite(broker) || !Number.isFinite(system) || !Number.isFinite(residualTolerance)) {
    return null;
  }

  const rawOffset = broker - system;
  const roundedHours = Math.round(rawOffset / HOUR_MS);
  if (Math.abs(roundedHours) > maxHours) return null;

  const offsetMs = roundedHours * HOUR_MS;
  if (Math.abs(rawOffset - offsetMs) > residualTolerance) return null;
  return offsetMs;
}

export function normalizeBrokerTimestamp(timestamp, clockOffsetMs = 0) {
  const value = Number(timestamp);
  const offset = Number(clockOffsetMs);
  if (!Number.isFinite(value) || !Number.isFinite(offset)) return null;
  return value - offset;
}

export function evaluateTimestampFreshness(timestamp, {
  now = Date.now(),
  maxAgeMs,
  futureToleranceMs = 10_000,
  clockOffsetMs = 0,
} = {}) {
  const value = Number(timestamp);
  const current = Number(now);
  const maximumAge = Number(maxAgeMs);
  const futureTolerance = Number(futureToleranceMs);
  const offset = Number(clockOffsetMs);

  if (
    !Number.isFinite(value) ||
    !Number.isFinite(current) ||
    !Number.isFinite(maximumAge) ||
    maximumAge <= 0 ||
    !Number.isFinite(offset)
  ) {
    return { fresh: false, reason: "TIMESTAMP_INPUT_INVALID", ageMs: null, rawAgeMs: null, clockOffsetMs: null };
  }

  const normalizedValue = value - offset;
  const rawAgeMs = current - value;
  const ageMs = current - normalizedValue;
  const resultBase = { ageMs, rawAgeMs, clockOffsetMs: offset, normalizedTimestamp: normalizedValue };

  if (ageMs < -Math.max(0, Number.isFinite(futureTolerance) ? futureTolerance : 0)) {
    return { fresh: false, reason: "TIMESTAMP_TOO_FAR_IN_FUTURE", ...resultBase };
  }
  if (ageMs > maximumAge) {
    return { fresh: false, reason: "TIMESTAMP_STALE", ...resultBase };
  }
  return { fresh: true, reason: "TIMESTAMP_FRESH", ...resultBase };
}

export function validateAutoLotSnapshot(payload, {
  accountLogin,
  accountMode,
  brokerSymbol,
  riskPercent,
  maxLot,
  stopDistance,
  now = Date.now(),
  maxAgeMs = 10_000,
} = {}) {
  if (!payload || typeof payload !== "object") {
    return { accepted: false, reason: "AUTO_LOT_PAYLOAD_MISSING" };
  }
  if (payload?.safety?.executionMutation !== false || payload?.safety?.phase7bFixedVolumeUnchanged !== true) {
    return { accepted: false, reason: "AUTO_LOT_SAFETY_ASSERTION_FAILED" };
  }
  const expectedAccountMode = String(accountMode ?? "").trim().toLowerCase();
  const actualAccountMode = String(payload?.account?.mode ?? "").trim().toLowerCase();
  if (expectedAccountMode !== "demo" && expectedAccountMode !== "real") {
    return {
      accepted: false,
      reason: "AUTO_LOT_EXPECTED_ACCOUNT_MODE_INVALID",
      expectedAccountMode,
      actualAccountMode,
    };
  }
  if (actualAccountMode !== expectedAccountMode) {
    return {
      accepted: false,
      reason: "AUTO_LOT_ACCOUNT_MODE_MISMATCH",
      expectedAccountMode,
      actualAccountMode,
    };
  }

  const expectedLogin = Number(accountLogin);
  const actualLogin = Number(payload?.account?.login);
  if (!Number.isFinite(expectedLogin) || !Number.isFinite(actualLogin) || actualLogin !== expectedLogin) {
    return { accepted: false, reason: "AUTO_LOT_ACCOUNT_LOGIN_MISMATCH", expectedLogin, actualLogin };
  }

  const expectedBrokerSymbol = String(brokerSymbol ?? "").trim();
  const actualBrokerSymbol = String(payload?.broker?.symbol ?? "").trim();
  if (!expectedBrokerSymbol || !actualBrokerSymbol || actualBrokerSymbol !== expectedBrokerSymbol) {
    return {
      accepted: false,
      reason: "AUTO_LOT_BROKER_SYMBOL_MISMATCH",
      expectedBrokerSymbol,
      actualBrokerSymbol,
    };
  }

  const expectedRiskPercent = Number(riskPercent);
  const actualRiskPercent = Number(payload?.configuration?.riskPercent);
  if (!sameNumber(expectedRiskPercent, actualRiskPercent, 1e-9)) {
    return {
      accepted: false,
      reason: "AUTO_LOT_RISK_PERCENT_MISMATCH",
      expectedRiskPercent,
      actualRiskPercent,
    };
  }

  const expectedMaxLot = Number(maxLot);
  const actualMaxLot = Number(payload?.configuration?.maxLot);
  if (!sameNumber(expectedMaxLot, actualMaxLot, 1e-9)) {
    return { accepted: false, reason: "AUTO_LOT_MAX_LOT_MISMATCH", expectedMaxLot, actualMaxLot };
  }

  const expectedStopDistance = Number(stopDistance);
  const actualStopDistance = Number(payload?.preview?.stopDistance);
  const stopTolerance = Math.max(1e-5, Math.abs(expectedStopDistance) * 1e-6);
  if (!sameNumber(expectedStopDistance, actualStopDistance, stopTolerance)) {
    return {
      accepted: false,
      reason: "AUTO_LOT_STOP_DISTANCE_MISMATCH",
      expectedStopDistance,
      actualStopDistance,
    };
  }

  // Auto Lot is generated by the local control API, not MT5, and therefore
  // intentionally remains on the system clock.
  const freshness = evaluateTimestampFreshness(payload?.generatedAt, { now, maxAgeMs, clockOffsetMs: 0 });
  if (!freshness.fresh) {
    return { accepted: false, reason: `AUTO_LOT_${freshness.reason}`, ageMs: freshness.ageMs };
  }

  const recommendedLot = Number(payload?.preview?.recommendedLot);
  if (payload?.preview?.approved !== true || !(recommendedLot > 0)) {
    return { accepted: false, reason: "AUTO_LOT_PREVIEW_NOT_APPROVED", recommendedLot };
  }

  return {
    accepted: true,
    reason: "AUTO_LOT_SNAPSHOT_VALID",
    recommendedLot,
    estimatedRiskUsd: Number(payload?.preview?.estimatedRiskUsd),
    generatedAt: Number(payload?.generatedAt),
  };
}

function sameNumber(left, right, tolerance) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}
