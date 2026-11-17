"use strict";

const REMOTE_ACTIONS = Object.freeze([
  "MODE_AUTO",
  "MODE_SEMI",
  "MODE_TREND",
  "MODE_SIDEWAY",
  "MODE_PAUSE",
  "ARM_LIVE",
  "DISARM_LIVE",
]);

const REMOTE_ACTION_SET = new Set(REMOTE_ACTIONS);
const MODE_ACTION_SET = new Set(REMOTE_ACTIONS.filter((action) => action.startsWith("MODE_")));
const ARM_ACTION_SET = new Set(["ARM_LIVE", "DISARM_LIVE"]);
const RISK_INCREASING = new Set([
  "MODE_AUTO",
  "MODE_SEMI",
  "MODE_TREND",
  "MODE_SIDEWAY",
  "ARM_LIVE",
]);

function assertObject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("INVALID_BODY");
  }
}

function assertOnlyKeys(input, keys) {
  const allowed = new Set(keys);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`UNEXPECTED_FIELD:${key}`);
  }
}

function parseActionBody(input) {
  assertObject(input);
  const action = String(input.action ?? "");
  if (!REMOTE_ACTION_SET.has(action)) throw new Error("UNSUPPORTED_ACTION");

  if (MODE_ACTION_SET.has(action)) {
    assertOnlyKeys(input, ["action", "confirmation"]);
    if (!input.confirmation) throw new Error("CONFIRMATION_REQUIRED");
    if (input.confirmation !== action) throw new Error("CONFIRMATION_MISMATCH");
    return { action, confirmation: action };
  }

  if (ARM_ACTION_SET.has(action)) {
    const phase = String(input.phase ?? "");
    if (phase !== "PREFLIGHT" && phase !== "EXECUTE") throw new Error("INVALID_PHASE");
    if (phase === "PREFLIGHT") {
      assertOnlyKeys(input, ["action", "phase"]);
      return { action, phase };
    }

    assertOnlyKeys(input, ["action", "phase", "transactionId", "confirmation"]);
    const transactionId = String(input.transactionId ?? "").trim();
    if (!transactionId) throw new Error("TRANSACTION_ID_REQUIRED");
    if (!input.confirmation) throw new Error("CONFIRMATION_REQUIRED");
    if (input.confirmation !== action) throw new Error("CONFIRMATION_MISMATCH");
    return { action, phase, transactionId, confirmation: action };
  }

  throw new Error("UNSUPPORTED_ACTION");
}

function isRiskIncreasing(action) {
  if (!REMOTE_ACTION_SET.has(action)) throw new Error("UNSUPPORTED_ACTION");
  return RISK_INCREASING.has(action);
}

module.exports = {
  REMOTE_ACTIONS,
  parseActionBody,
  isRiskIncreasing,
};
