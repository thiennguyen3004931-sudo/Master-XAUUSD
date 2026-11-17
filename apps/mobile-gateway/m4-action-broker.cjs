"use strict";

const { parseActionBody, isRiskIncreasing } = require("./m4-contract.cjs");

function normalizeIdentity(value) {
  return String(value ?? "").trim().toLowerCase();
}

function boundedMessage(error) {
  return String(error instanceof Error ? error.message : error ?? "UNKNOWN_ERROR").slice(0, 500);
}

function failureResult(action, error) {
  const httpStatus = Number(error?.status) || 502;
  return {
    action,
    outcome: httpStatus >= 400 && httpStatus < 500 ? "FAIL" : "AMBIGUOUS",
    httpStatus,
    message: boundedMessage(error),
  };
}

function sanitizePreflight(preflight) {
  const { preflightToken: _secret, ...safe } = preflight || {};
  return safe;
}

function createM4ActionBroker({ canonical, transactions, audit, now = Date.now } = {}) {
  if (!canonical) throw new Error("CANONICAL_CLIENT_REQUIRED");
  if (!transactions) throw new Error("TRANSACTION_STORE_REQUIRED");
  if (!audit || (!audit.append && !audit.before && !audit.after)) throw new Error("AUDIT_SINK_REQUIRED");

  async function writeAudit(event, phase, mandatory) {
    const fullEvent = {
      timestamp: new Date(now()).toISOString(),
      identity: normalizeIdentity(event.identity),
      action: event.action,
      phase,
      transactionId: event.transactionId ?? null,
      ...(event.outcome ? { outcome: event.outcome } : {}),
      ...(event.httpStatus ? { httpStatus: event.httpStatus } : {}),
      ...(event.requestId ? { requestId: event.requestId } : {}),
    };
    try {
      let handled = false;
      if (audit.append) {
        handled = true;
        await audit.append(fullEvent);
      } else if (phase === "ATTEMPT" && audit.before) {
        handled = true;
        await audit.before(fullEvent);
      } else if (phase === "RESULT" && audit.after) {
        handled = true;
        await audit.after(fullEvent);
      }
      if (!handled) throw new Error("AUDIT_HANDLER_UNAVAILABLE");
      return true;
    } catch (error) {
      if (mandatory) throw error;
      return false;
    }
  }

  async function getState(identity) {
    const [botMode, auto, arm] = await Promise.all([
      canonical.getBotMode(),
      canonical.getAutoStatus(),
      canonical.getArmCapability(),
    ]);
    const mode = botMode?.state?.mode ?? botMode?.mode ?? arm?.botMode ?? auto?.botMode ?? "UNKNOWN";
    return {
      operator: normalizeIdentity(identity),
      mode,
      auto: {
        approved: auto?.approved === true,
        accountMode: auto?.accountMode ?? null,
        botMode: auto?.botMode ?? mode,
        liveArmRequired: auto?.liveArmRequired === true,
        liveArmStatus: auto?.liveArmStatus ?? null,
        checks: auto?.checks ?? {},
        blockedBy: Array.isArray(auto?.blockedBy) ? auto.blockedBy : [],
      },
      arm: {
        accountMode: arm?.accountMode ?? null,
        botMode: arm?.botMode ?? mode,
        liveArmStatus: arm?.liveArmStatus ?? null,
        liveExecutionArmed: arm?.liveExecutionArmed === true,
        bridgeSessionId: arm?.bridgeSessionId ?? null,
        openXauusdPositions: Number(arm?.openXauusdPositions ?? 0),
        canArm: arm?.canArm === true,
        canDisarm: arm?.canDisarm === true,
        armChecks: arm?.armChecks ?? {},
        armBlockedBy: Array.isArray(arm?.armBlockedBy) ? arm.armBlockedBy : [],
        disarmChecks: arm?.disarmChecks ?? {},
        disarmBlockedBy: Array.isArray(arm?.disarmBlockedBy) ? arm.disarmBlockedBy : [],
      },
    };
  }

  async function handleMode(identity, parsed) {
    const baseEvent = { identity, action: parsed.action, transactionId: null };
    let auditDegraded = !(await writeAudit(baseEvent, "ATTEMPT", isRiskIncreasing(parsed.action)));
    try {
      const result = await canonical.executeModeAction(parsed.action);
      const resultAudit = await writeAudit({ ...baseEvent, outcome: "PASS" }, "RESULT", false);
      auditDegraded ||= !resultAudit;
      return { action: parsed.action, outcome: "PASS", result, ...(auditDegraded ? { auditDegraded: true } : {}) };
    } catch (error) {
      const response = failureResult(parsed.action, error);
      const resultAudit = await writeAudit({
        ...baseEvent,
        outcome: response.outcome,
        httpStatus: response.httpStatus,
      }, "RESULT", false);
      auditDegraded ||= !resultAudit;
      return { ...response, ...(auditDegraded ? { auditDegraded: true } : {}) };
    }
  }

  async function handlePreflight(identity, parsed) {
    const normalized = normalizeIdentity(identity);
    await canonical.getArmCapability();
    const preflight = await canonical.createArmPreflight(parsed.action);
    const safe = sanitizePreflight(preflight);

    if (!preflight?.approved || !preflight?.preflightToken) {
      return { action: parsed.action, phase: "PREFLIGHT", approved: false, ...safe };
    }

    const transactionId = transactions.create({
      identity: normalized,
      action: parsed.action,
      canonicalToken: preflight.preflightToken,
      expiresAt: preflight.expiresAt,
      preflight: safe,
    });

    return {
      action: parsed.action,
      phase: "PREFLIGHT",
      approved: true,
      transactionId,
      ...safe,
    };
  }

  async function handleExecute(identity, parsed) {
    const record = transactions.getForExecute(identity, parsed.action, parsed.transactionId);
    const token = record.canonicalToken;
    const baseEvent = { identity, action: parsed.action, transactionId: parsed.transactionId };
    let auditDegraded = !(await writeAudit(baseEvent, "ATTEMPT", isRiskIncreasing(parsed.action)));

    transactions.markExecuting(parsed.transactionId);

    try {
      const accepted = await canonical.executeArm(parsed.action, token);
      if (!accepted?.requestId) {
        const resultAudit = await writeAudit({ ...baseEvent, outcome: "AMBIGUOUS" }, "RESULT", false);
        auditDegraded ||= !resultAudit;
        return {
          action: parsed.action,
          transactionId: parsed.transactionId,
          outcome: "AMBIGUOUS",
          message: "CANONICAL_REQUEST_ID_MISSING",
          ...(auditDegraded ? { auditDegraded: true } : {}),
        };
      }
      transactions.setRequestId(parsed.transactionId, accepted.requestId);
      const resultAudit = await writeAudit({
        ...baseEvent,
        outcome: "RUNNING",
        requestId: accepted.requestId,
      }, "RESULT", false);
      auditDegraded ||= !resultAudit;
      return {
        action: parsed.action,
        transactionId: parsed.transactionId,
        requestId: accepted.requestId,
        outcome: "RUNNING",
        message: String(accepted.message ?? "accepted"),
        ...(auditDegraded ? { auditDegraded: true } : {}),
      };
    } catch (error) {
      const failure = failureResult(parsed.action, error);
      const resultAudit = await writeAudit({
        ...baseEvent,
        outcome: failure.outcome,
        httpStatus: failure.httpStatus,
      }, "RESULT", false);
      auditDegraded ||= !resultAudit;
      return {
        transactionId: parsed.transactionId,
        ...failure,
        ...(auditDegraded ? { auditDegraded: true } : {}),
      };
    }
  }

  async function handleAction(identity, body) {
    const parsed = parseActionBody(body);
    if (parsed.action.startsWith("MODE_")) return handleMode(identity, parsed);
    if (parsed.phase === "PREFLIGHT") return handlePreflight(identity, parsed);
    return handleExecute(identity, parsed);
  }

  async function getTransactionStatus(identity, transactionId) {
    const record = transactions.readStatus(identity, transactionId);
    if (!record.requestId) {
      return {
        transactionId: record.transactionId,
        action: record.action,
        status: record.consumed ? "AMBIGUOUS" : "PREFLIGHT_READY",
        finalArmStatus: null,
      };
    }

    const canonicalStatus = await canonical.getArmStatus(record.requestId);
    const expectedFinal = record.action === "ARM_LIVE" ? "ARMED" : "DISARMED";
    let status = canonicalStatus?.status ?? "AMBIGUOUS";
    if (status === "PASS" && String(canonicalStatus?.finalArmStatus ?? "").toUpperCase() !== expectedFinal) {
      status = "AMBIGUOUS";
    }

    const safe = {
      transactionId: record.transactionId,
      action: record.action,
      requestId: record.requestId,
      status,
      phase: canonicalStatus?.phase ?? "UNKNOWN",
      message: String(canonicalStatus?.message ?? ""),
      finalArmStatus: canonicalStatus?.finalArmStatus ?? null,
    };
    transactions.updateCanonicalStatus(transactionId, safe);
    return safe;
  }

  return Object.freeze({ getState, handleAction, getTransactionStatus });
}

module.exports = { createM4ActionBroker };
