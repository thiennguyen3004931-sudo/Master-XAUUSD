const EPSILON = 1e-9;

export function reconcileManagedVolume(managed, position, spec, partialActivationTimestamp = null) {
  if (!managed || !position) {
    return { accepted: false, reason: "MANAGED_OR_POSITION_MISSING", managed, events: [] };
  }

  const step = Number(spec?.volumeStep);
  const minVolume = Number(spec?.minVolume);
  if (!(step > 0) || !(minVolume > 0)) {
    return { accepted: false, reason: "BROKER_VOLUME_SPEC_INVALID", managed, events: [] };
  }

  const next = { ...managed };
  const events = [];
  const expectedTicket = String(next.ticket ?? "");
  const actualTicket = String(position.ticket ?? "");
  if (!expectedTicket || actualTicket !== expectedTicket) {
    return {
      accepted: false,
      reason: "MANAGED_TICKET_MISMATCH",
      managed: next,
      events,
      expectedTicket,
      actualTicket,
    };
  }

  const expectedSide = next.side === "BUY" ? "LONG" : next.side === "SELL" ? "SHORT" : null;
  if (!expectedSide || position.side !== expectedSide) {
    return {
      accepted: false,
      reason: "MANAGED_SIDE_MISMATCH",
      managed: next,
      events,
      expectedSide,
      actualSide: position.side ?? null,
    };
  }

  const initialVolume = Number(next.initialVolume);
  const expectedVolume = Number(next.expectedRemainingVolume);
  const actualVolume = Number(position.volume);
  if (
    ![initialVolume, expectedVolume, actualVolume].every(Number.isFinite) ||
    !(initialVolume > 0) ||
    !(expectedVolume > 0) ||
    !(actualVolume > 0)
  ) {
    return {
      accepted: false,
      reason: "MANAGED_VOLUME_INVALID",
      managed: next,
      events,
      initialVolume,
      expectedVolume,
      actualVolume,
    };
  }

  const tolerance = volumeTolerance(step);
  if (actualVolume > expectedVolume + tolerance) {
    return {
      accepted: false,
      reason: "MANAGED_VOLUME_INCREASE",
      managed: next,
      events,
      expectedVolume,
      actualVolume,
    };
  }

  if (
    actualVolume < minVolume - tolerance ||
    expectedVolume < minVolume - tolerance ||
    actualVolume > initialVolume + tolerance ||
    expectedVolume > initialVolume + tolerance ||
    !isStepAligned(initialVolume, step) ||
    !isStepAligned(expectedVolume, step) ||
    !isStepAligned(actualVolume, step)
  ) {
    return {
      accepted: false,
      reason: "MANAGED_VOLUME_NOT_BROKER_REPRESENTABLE",
      managed: next,
      events,
      initialVolume,
      expectedVolume,
      actualVolume,
    };
  }

  if (Math.abs(actualVolume - expectedVolume) <= tolerance) {
    return {
      accepted: true,
      reason: "MANAGED_VOLUME_ALREADY_MATCHED",
      managed: next,
      events,
      expectedVolume,
      actualVolume,
    };
  }

  const oneThirdVolume = exactOneThirdVolume(initialVolume, minVolume, step);
  if (!(oneThirdVolume > 0)) {
    return {
      accepted: false,
      reason: "MANAGED_ONE_THIRD_NOT_REPRESENTABLE",
      managed: next,
      events,
      initialVolume,
      expectedVolume,
      actualVolume,
    };
  }

  const previousExpectedVolume = expectedVolume;
  const externalReduction = normalizeVolume(expectedVolume - actualVolume, step);
  const totalClosedFromInitial = normalizeVolume(initialVolume - actualVolume, step);
  next.expectedRemainingVolume = normalizeVolume(actualVolume, step);

  events.push({
    type: "MANAGED_VOLUME_DECREASE_RECONCILED",
    previousExpectedVolume,
    actualVolume: next.expectedRemainingVolume,
    externalReduction,
    totalClosedFromInitial,
    oneThirdVolume,
  });

  if (!next.partialApplied && totalClosedFromInitial + tolerance >= oneThirdVolume) {
    next.partialApplied = true;
    if (
      Object.prototype.hasOwnProperty.call(next, "partialActivatedAt") &&
      (next.partialActivatedAt === null || !Number.isFinite(Number(next.partialActivatedAt))) &&
      Number.isFinite(Number(partialActivationTimestamp)) &&
      Number(partialActivationTimestamp) > 0
    ) {
      next.partialActivatedAt = Number(partialActivationTimestamp);
    }
    events.push({
      type: "PLUS10_PARTIAL_SATISFIED_EXTERNALLY",
      actualVolume: next.expectedRemainingVolume,
      totalClosedFromInitial,
      requiredOneThirdVolume: oneThirdVolume,
    });
  }

  return {
    accepted: true,
    reason: "MANAGED_VOLUME_DECREASE_RECONCILED",
    managed: next,
    events,
    expectedVolume: previousExpectedVolume,
    actualVolume: next.expectedRemainingVolume,
  };
}

export function remainingManagedPartialVolume(managed, currentVolume, spec) {
  if (!managed || managed.partialApplied) return 0;

  const step = Number(spec?.volumeStep);
  const minVolume = Number(spec?.minVolume);
  const initialVolume = Number(managed.initialVolume);
  const actualVolume = Number(currentVolume);
  if (
    !(step > 0) ||
    !(minVolume > 0) ||
    !(initialVolume > 0) ||
    !(actualVolume > 0) ||
    !isStepAligned(initialVolume, step) ||
    !isStepAligned(actualVolume, step)
  ) {
    return 0;
  }

  const oneThirdVolume = exactOneThirdVolume(initialVolume, minVolume, step);
  if (!(oneThirdVolume > 0)) return 0;

  const tolerance = volumeTolerance(step);
  const totalClosedFromInitial = normalizeVolume(
    Math.max(0, initialVolume - actualVolume),
    step,
  );
  const remainingObligation = oneThirdVolume - totalClosedFromInitial;
  if (remainingObligation <= tolerance) return 0;

  const closeVolume = normalizeVolume(remainingObligation, step);
  if (
    closeVolume < minVolume - tolerance ||
    !isStepAligned(closeVolume, step)
  ) {
    return 0;
  }

  const brokerRemaining = normalizeVolume(actualVolume - closeVolume, step);
  if (brokerRemaining < minVolume - tolerance) return 0;
  return Math.min(closeVolume, actualVolume);
}

function exactOneThirdVolume(initialVolume, minVolume, step) {
  const rawThird = initialVolume / 3;
  const units = rawThird / step;
  if (Math.abs(units - Math.round(units)) > 1e-8) return 0;
  const normalized = normalizeVolume(rawThird, step);
  if (normalized < minVolume - volumeTolerance(step)) return 0;
  return normalized;
}

function isStepAligned(value, step) {
  if (!Number.isFinite(value) || !(value > 0) || !(step > 0)) return false;
  const units = value / step;
  return Math.abs(units - Math.round(units)) <= 1e-8;
}

function normalizeVolume(value, step) {
  if (!Number.isFinite(value) || !(step > 0)) return 0;
  const units = Math.round((value + EPSILON) / step);
  return Math.round(Math.max(0, units * step) * 100_000_000) / 100_000_000;
}

function volumeTolerance(step) {
  return step / 2 + EPSILON;
}
