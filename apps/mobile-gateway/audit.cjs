"use strict";

const fs = require("node:fs");
const path = require("node:path");

function canonicalTarget(action) {
  if (action === "MODE_AUTO") return "PHASE7C_AUTO_ACTIVATION";
  if (String(action).startsWith("MODE_")) return "PHASE7C_BOT_MODE";
  if (action === "ARM_LIVE" || action === "DISARM_LIVE") return "PHASE7C_LIVE_ARM_CONTROL";
  throw new Error("AUDIT_UNSUPPORTED_ACTION");
}

function buildAuditEvent(input) {
  const event = {
    version: 1,
    timestamp: String(input.timestamp),
    identity: String(input.identity ?? "").trim().toLowerCase(),
    action: String(input.action),
    phase: String(input.phase),
    transactionId: input.transactionId ? String(input.transactionId) : null,
    canonicalTarget: canonicalTarget(input.action),
  };

  if (input.outcome !== undefined) event.outcome = String(input.outcome);
  if (input.httpStatus !== undefined && input.httpStatus !== null) event.httpStatus = Number(input.httpStatus);
  if (input.requestId) event.requestId = String(input.requestId);
  if (input.auditDegraded === true) event.auditDegraded = true;
  return event;
}

function createAuditSink({ auditPath, appendFileSync = fs.appendFileSync, mkdirSync = fs.mkdirSync } = {}) {
  if (!auditPath || typeof auditPath !== "string") throw new Error("AUDIT_PATH_REQUIRED");
  const directory = path.dirname(auditPath);

  return Object.freeze({
    append(event) {
      mkdirSync(directory, { recursive: true });
      appendFileSync(auditPath, `${JSON.stringify(buildAuditEvent(event))}\n`, { encoding: "utf8" });
    },
  });
}

module.exports = {
  canonicalTarget,
  buildAuditEvent,
  createAuditSink,
};
