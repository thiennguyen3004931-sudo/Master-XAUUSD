import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildNaturalPositionManagementWitness } from "./phase7c-natural-position-management-witness.mjs";

const position = (overrides = {}) => ({
  ticket: "304783904",
  symbol: "XAUUSD",
  side: "LONG",
  entry: 4392.52,
  volume: 0.03,
  stopLoss: 4386.52,
  takeProfit: 4412.52,
  ...overrides,
});

const managed = (overrides = {}) => ({
  ticket: "304783904",
  side: "BUY",
  partialApplied: false,
  fastMovePeakPrice: 4392.52,
  fastMoveAttempt: 0,
  fastMoveHandedOffToM5: false,
  ...overrides,
});

function witness(overrides = {}) {
  return buildNaturalPositionManagementWitness({
    positions: [position()],
    trendState: { managed: managed() },
    sidewayState: { managed: null },
    trendJournal: [],
    sidewayJournal: [],
    ...overrides,
  });
}

test("NO_POSITION is pending rather than failure", () => {
  const result = witness({ positions: [] });
  assert.equal(result.status, "PENDING_NO_POSITION");
  assert.equal(result.isFailure, false);
});

test("ONE_POSITION plus one exact persisted owner becomes ACTIVE_CAPTURE", () => {
  const result = witness();
  assert.equal(result.status, "ACTIVE_CAPTURE");
  assert.equal(result.owner, "TREND");
  assert.equal(result.ticket, "304783904");
  assert.deepEqual(result.brokerProtection, {
    stopLoss: 4386.52,
    takeProfit: 4412.52,
  });
});

test("SIDEWAY exact ticket can be the unique persisted owner", () => {
  const result = witness({
    trendState: { managed: null },
    sidewayState: { managed: managed() },
  });
  assert.equal(result.status, "ACTIVE_CAPTURE");
  assert.equal(result.owner, "SIDEWAY");
});

test("missing or duplicate persisted ownership blocks as ambiguous", () => {
  const missing = witness({ trendState: { managed: null } });
  assert.equal(missing.status, "BLOCKED_AMBIGUOUS");
  assert.equal(missing.reason, "EXACT_OWNER_NOT_FOUND");

  const duplicate = witness({ sidewayState: { managed: managed() } });
  assert.equal(duplicate.status, "BLOCKED_AMBIGUOUS");
  assert.equal(duplicate.reason, "EXACT_OWNER_NOT_UNIQUE");
});

test("multiple broker positions block before ownership capture", () => {
  const result = witness({
    positions: [position(), position({ ticket: "304783905" })],
  });
  assert.equal(result.status, "BLOCKED_AMBIGUOUS");
  assert.equal(result.reason, "MULTIPLE_POSITION");
});

test("FastMove peak and partial are read from durable managed state, not recomputed", () => {
  const result = witness({
    trendState: {
      managed: managed({
        partialApplied: true,
        partialActivatedAt: 1788956541830,
        fastMovePeakPrice: 4405.25,
      }),
    },
  });
  assert.equal(result.fastMove.peakPrice, 4405.25);
  assert.equal(result.partial.status, "APPLIED");
  assert.equal(result.partial.activatedAt, 1788956541830);
});

test("missing nullable evidence remains null rather than being coerced to zero", () => {
  const result = witness({
    positions: [position({ stopLoss: null, takeProfit: null })],
    trendState: {
      managed: managed({
        partialActivatedAt: null,
        fastMovePeakPrice: null,
      }),
    },
  });

  assert.deepEqual(result.brokerProtection, {
    stopLoss: null,
    takeProfit: null,
  });
  assert.equal(result.partial.activatedAt, null);
  assert.equal(result.fastMove.peakPrice, null);
});

test("NO_FASTMOVE_TRIGGER is explicitly NOT_TRIGGERED and not a regression", () => {
  const result = witness();
  assert.equal(result.fastMove.status, "NOT_TRIGGERED");
  assert.equal(result.fastMove.isRegression, false);
});

test("FastMove trigger is established only by persisted attempt or exact-ticket canonical journal evidence", () => {
  const fromState = witness({
    trendState: { managed: managed({ fastMoveAttempt: 1 }) },
  });
  assert.equal(fromState.fastMove.status, "TRIGGERED");

  const fromJournal = witness({
    trendJournal: [
      {
        type: "FAST_MOVE_PROFIT_LOCK_TIGHTEN",
        ticket: "304783904",
        peakPrice: 4404.2,
        stopLoss: 4394.2,
      },
      {
        type: "FAST_MOVE_PROFIT_LOCK_TIGHTEN",
        ticket: "other-ticket",
        peakPrice: 9999,
        stopLoss: 9990,
      },
    ],
  });
  assert.equal(fromJournal.fastMove.status, "TRIGGERED");
  assert.equal(fromJournal.fastMove.events.length, 1);
});

test("M5 handoff is proven from durable flag plus exact-ticket handoff journal; otherwise absence is NOT_APPLICABLE", () => {
  const notApplicable = witness();
  assert.equal(notApplicable.m5.status, "NOT_APPLICABLE");

  const handedOff = witness({
    trendState: { managed: managed({ fastMoveHandedOffToM5: true }) },
    trendJournal: [
      {
        type: "FAST_MOVE_HANDOFF_M5_STRUCTURE",
        ticket: "304783904",
        structurePrice: 4399.1,
        pivotM5CloseTime: 1788956500000,
        m5CloseTime: 1788956800000,
      },
    ],
  });
  assert.equal(handedOff.m5.status, "HANDED_OFF");
  assert.equal(handedOff.m5.handoffEvent.structurePrice, 4399.1);
});

test("durable M5 handoff flag without matching journal is fail-closed as UNPROVEN", () => {
  const result = witness({
    trendState: { managed: managed({ fastMoveHandedOffToM5: true }) },
  });
  assert.equal(result.m5.status, "UNPROVEN");
});

test("SL monotonicity remains UNPROVEN with no canonical successful tighten history", () => {
  const result = witness();
  assert.equal(result.slMonotonicity.status, "UNPROVEN");
  assert.equal(result.slMonotonicity.events.length, 0);
});

test("successful canonical tighten events are exposed as proof evidence without re-running stop logic", () => {
  const result = witness({
    trendJournal: [
      {
        type: "M5_STRUCTURAL_SL_TIGHTEN",
        ticket: "304783904",
        previousStopLoss: 4386.52,
        stopLoss: 4392.52,
      },
    ],
  });
  assert.equal(result.slMonotonicity.status, "PROVEN_BY_CANONICAL_TIGHTEN_EVENT");
  assert.equal(result.slMonotonicity.events.length, 1);
  assert.equal(result.slMonotonicity.events[0].previousStopLoss, 4386.52);
  assert.equal(result.slMonotonicity.events[0].stopLoss, 4392.52);
});

test("witness source cannot import or recreate FastMove/M5 market algorithms", () => {
  const sourcePath = path.resolve(
    process.cwd(),
    "scripts",
    "phase7c-natural-position-management-witness.mjs",
  );
  const source = fs.readFileSync(sourcePath, "utf8");

  for (const forbidden of [
    "phase7c-fast-move-profit-lock",
    "phase7c-m5-structural-trailing",
    "fastMoveProfitLockCandidate",
    "evaluateM5StructuralTrail",
    "latestConfirmedM5Structure",
    "activationDistance",
    "givebackDistance",
    "/v1/candles/",
  ]) {
    assert.equal(source.includes(forbidden), false, `witness must not contain ${forbidden}`);
  }
});
