const FAST_MOVE_EVENT_TYPES = new Set([
  "FAST_MOVE_PROFIT_LOCK_TIGHTEN",
  "FAST_MOVE_PROFIT_LOCK_REJECTED",
]);

const M5_HANDOFF_EVENT_TYPE = "FAST_MOVE_HANDOFF_M5_STRUCTURE";
const CANONICAL_SL_TIGHTEN_EVENT_TYPES = new Set([
  "M5_STRUCTURAL_SL_TIGHTEN",
]);

function ticketOf(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim().length === 0) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function journalForTicket(rows, ticket) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => row && ticketOf(row.ticket) === ticket);
}

function blocked(reason, extra = {}) {
  return {
    status: "BLOCKED_AMBIGUOUS",
    isFailure: true,
    reason,
    ...extra,
  };
}

export function buildNaturalPositionManagementWitness(input = {}) {
  const positions = Array.isArray(input.positions) ? input.positions : [];

  if (positions.length === 0) {
    return {
      status: "PENDING_NO_POSITION",
      isFailure: false,
      reason: "NO_POSITION",
    };
  }

  if (positions.length !== 1) {
    return blocked("MULTIPLE_POSITION", {
      positionTickets: positions.map((position) => ticketOf(position?.ticket)),
    });
  }

  const position = positions[0] ?? {};
  const ticket = ticketOf(position.ticket);
  if (!ticket) {
    return blocked("BROKER_TICKET_INVALID");
  }

  const owners = [
    { strategy: "TREND", managed: input.trendState?.managed ?? null, journal: input.trendJournal },
    { strategy: "SIDEWAY", managed: input.sidewayState?.managed ?? null, journal: input.sidewayJournal },
  ].filter(({ managed }) => managed && ticketOf(managed.ticket) === ticket);

  if (owners.length === 0) {
    return blocked("EXACT_OWNER_NOT_FOUND", { ticket });
  }

  if (owners.length !== 1) {
    return blocked("EXACT_OWNER_NOT_UNIQUE", {
      ticket,
      owners: owners.map(({ strategy }) => strategy),
    });
  }

  const owner = owners[0];
  const managed = owner.managed;
  const journal = journalForTicket(owner.journal, ticket);

  const fastMoveEvents = journal.filter((row) => FAST_MOVE_EVENT_TYPES.has(row.type));
  const fastMoveAttempt = finiteNumberOrNull(managed.fastMoveAttempt) ?? 0;
  const fastMoveTriggered = fastMoveAttempt > 0 || fastMoveEvents.length > 0;

  const handoffEvents = journal.filter((row) => row.type === M5_HANDOFF_EVENT_TYPE);
  const durableM5Handoff = managed.fastMoveHandedOffToM5 === true;
  let m5Status = "NOT_APPLICABLE";
  let handoffEvent = null;
  if (durableM5Handoff && handoffEvents.length > 0) {
    m5Status = "HANDED_OFF";
    handoffEvent = handoffEvents.at(-1);
  } else if (durableM5Handoff || handoffEvents.length > 0) {
    m5Status = "UNPROVEN";
    handoffEvent = handoffEvents.at(-1) ?? null;
  }

  const slTightenEvents = journal.filter((row) =>
    CANONICAL_SL_TIGHTEN_EVENT_TYPES.has(row.type) &&
    finiteNumberOrNull(row.previousStopLoss) !== null &&
    finiteNumberOrNull(row.stopLoss) !== null,
  );

  return {
    status: "ACTIVE_CAPTURE",
    isFailure: false,
    reason: "ONE_POSITION_EXACT_OWNER",
    owner: owner.strategy,
    ticket,
    brokerProtection: {
      stopLoss: finiteNumberOrNull(position.stopLoss),
      takeProfit: finiteNumberOrNull(position.takeProfit),
    },
    partial: {
      status: managed.partialApplied === true ? "APPLIED" : "NOT_APPLIED",
      activatedAt: finiteNumberOrNull(managed.partialActivatedAt),
    },
    fastMove: {
      status: fastMoveTriggered ? "TRIGGERED" : "NOT_TRIGGERED",
      isRegression: false,
      peakPrice: finiteNumberOrNull(managed.fastMovePeakPrice),
      attempt: fastMoveAttempt,
      events: fastMoveEvents,
    },
    m5: {
      status: m5Status,
      durableHandoff: durableM5Handoff,
      handoffEvent,
    },
    slMonotonicity: {
      status: slTightenEvents.length > 0
        ? "PROVEN_BY_CANONICAL_TIGHTEN_EVENT"
        : "UNPROVEN",
      events: slTightenEvents,
    },
  };
}
