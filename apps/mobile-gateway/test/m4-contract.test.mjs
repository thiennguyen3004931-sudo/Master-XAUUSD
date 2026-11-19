import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  REMOTE_ACTIONS,
  parseActionBody,
  isRiskIncreasing,
} = require("../m4-contract.cjs");

const APPROVED = [
  "MODE_AUTO",
  "MODE_SEMI",
  "MODE_TREND",
  "MODE_SIDEWAY",
  "MODE_PAUSE",
  "ARM_LIVE",
  "DISARM_LIVE",
];

test("remote action allowlist is exact", () => {
  assert.deepEqual([...REMOTE_ACTIONS], APPROVED);
});

test("rejects unsupported and arbitrary control surfaces", () => {
  for (const action of ["LIFECYCLE_START", "ORDER_BUY", "POSITION_CLOSE", "LOT_SET", "ACCOUNT_SWITCH"]) {
    assert.throws(() => parseActionBody({ action }), /UNSUPPORTED_ACTION/);
  }
});

test("rejects caller supplied upstream or canonical body controls", () => {
  for (const extra of ["url", "path", "method", "source", "body"]) {
    assert.throws(
      () => parseActionBody({ action: "MODE_TREND", confirmation: "MODE_TREND", [extra]: "evil" }),
      /UNEXPECTED_FIELD/,
    );
  }
});

test("mode action requires exact confirmation", () => {
  assert.deepEqual(parseActionBody({ action: "MODE_TREND", confirmation: "MODE_TREND" }), {
    action: "MODE_TREND",
    confirmation: "MODE_TREND",
  });
  assert.throws(() => parseActionBody({ action: "MODE_TREND" }), /CONFIRMATION_REQUIRED/);
  assert.throws(() => parseActionBody({ action: "MODE_TREND", confirmation: "MODE_AUTO" }), /CONFIRMATION_MISMATCH/);
});

test("ARM and DISARM accept only bounded PREFLIGHT or EXECUTE shapes", () => {
  assert.deepEqual(parseActionBody({ action: "ARM_LIVE", phase: "PREFLIGHT" }), {
    action: "ARM_LIVE",
    phase: "PREFLIGHT",
  });
  assert.deepEqual(parseActionBody({
    action: "DISARM_LIVE",
    phase: "EXECUTE",
    transactionId: "tx-1",
    confirmation: "DISARM_LIVE",
  }), {
    action: "DISARM_LIVE",
    phase: "EXECUTE",
    transactionId: "tx-1",
    confirmation: "DISARM_LIVE",
  });
  assert.throws(() => parseActionBody({ action: "ARM_LIVE", phase: "EXECUTE", transactionId: "tx-1" }), /CONFIRMATION_REQUIRED/);
  assert.throws(() => parseActionBody({ action: "ARM_LIVE", phase: "BOGUS" }), /INVALID_PHASE/);
});

test("risk classification keeps PAUSE and DISARM risk-reducing", () => {
  for (const action of ["MODE_AUTO", "MODE_SEMI", "MODE_TREND", "MODE_SIDEWAY", "ARM_LIVE"]) {
    assert.equal(isRiskIncreasing(action), true, action);
  }
  assert.equal(isRiskIncreasing("MODE_PAUSE"), false);
  assert.equal(isRiskIncreasing("DISARM_LIVE"), false);
});
