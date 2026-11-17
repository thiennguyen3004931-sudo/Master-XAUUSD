import assert from "node:assert/strict";
import fs from "node:fs";

import { transformPhase7CTrendM5TrailingSource } from "./phase7c-m5-structural-trailing-source-adapter.mjs";
import { transformPhase7CTrendM5PreStructureProfitLockSource } from "./phase7c-m5-prestructure-profit-lock-source-adapter.mjs";
import { fastMoveProfitLockCandidate } from "./phase7c-fast-move-profit-lock.mjs";
import { evaluateM5StructuralTrail } from "./phase7c-m5-structural-trailing.mjs";

const raw = fs.readFileSync(new URL("./run-phase7b-demo-controller.ts", import.meta.url), "utf8");

assert.equal(
  raw.includes("recordManagementExitSideSample({ managed, quote, exitSidePrice });"),
  false,
  "TREND management must not reference an undefined exitSidePrice variable.",
);
assert.equal(
  raw.includes("recordManagementExitSideSample({ managed, quote, exitSidePrice: exitPrice });"),
  true,
  "TREND management must persist the canonical BUY-bid / SELL-ask exitPrice sample.",
);

const transformed = transformPhase7CTrendM5PreStructureProfitLockSource(
  transformPhase7CTrendM5TrailingSource(raw),
);

for (const literal of [
  "if (!managed.breakEvenApplied && favorable >= 6)",
  "if (!managed.partialApplied && favorable >= 10)",
  "const fastMoveEligible = stopIsAtLeastAsTight(",
  'journal("FAST_MOVE_PROFIT_LOCK_TIGHTEN"',
  "evaluateM5StructuralTrail({",
  'journal("M5_STRUCTURAL_SL_TIGHTEN"',
  'journal("FAST_MOVE_HANDOFF_M5_STRUCTURE"',
]) {
  assert.equal(
    transformed.includes(literal),
    true,
    `TREND transformed runtime must retain management stage: ${literal}`,
  );
}

const sampleIndex = transformed.indexOf(
  "recordManagementExitSideSample({ managed, quote, exitSidePrice: exitPrice });",
);
const beIndex = transformed.indexOf("if (!managed.breakEvenApplied && favorable >= 6)");
const fastMoveIndex = transformed.indexOf("fastMoveProfitLockCandidate({");
const partialIndex = transformed.indexOf("if (!managed.partialApplied && favorable >= 10)");
const m5Index = transformed.indexOf("evaluateM5StructuralTrail({");

assert.ok(sampleIndex >= 0 && sampleIndex < beIndex, "Exit-side evidence must be fail-open and execute before BE without breaking management.");
assert.ok(beIndex >= 0 && beIndex < partialIndex, "BE must remain before +10 partial.");
assert.ok(fastMoveIndex >= 0 && fastMoveIndex < partialIndex, "FastMove evaluation must remain available before +10 partial.");
assert.ok(m5Index > partialIndex, "M5 structural trailing must remain post-partial.");

const sellFastMove = fastMoveProfitLockCandidate({
  side: "SELL",
  entry: 4284.17,
  marketPrice: 4268.0,
  previousPeakPrice: 4268.0,
  activationDistance: 10,
  givebackDistance: 10,
});
assert.equal(sellFastMove.active, true);
assert.equal(sellFastMove.reason, "ACTIVE");
assert.ok(sellFastMove.candidateStop < 4284.17, "SELL FastMove must lock positive profit below entry.");

const sellExactlyPlus10 = fastMoveProfitLockCandidate({
  side: "SELL",
  entry: 4284.17,
  marketPrice: 4274.17,
  previousPeakPrice: 4274.17,
  activationDistance: 10,
  givebackDistance: 10,
});
assert.equal(sellExactlyPlus10.active, false);
assert.equal(sellExactlyPlus10.reason, "CANDIDATE_NOT_PROFIT_LOCK");

const sellBars = [
  { closeTime: 1_000, low: 4260, high: 4273 },
  { closeTime: 2_000, low: 4262, high: 4275 },
  { closeTime: 3_000, low: 4261, high: 4274 },
];

const m5Tighten = evaluateM5StructuralTrail({
  side: "SELL",
  bars: sellBars,
  afterTimestamp: 0,
  atOrBefore: 3_000,
  currentStop: 4284.17,
  lastStructuralStop: 4284.17,
  bid: 4268.8,
  ask: 4269.0,
  digits: 2,
  point: 0.01,
  stopsLevelTicks: 50,
  freezeLevelTicks: 50,
});
assert.equal(m5Tighten.allowed, true);
assert.equal(m5Tighten.reason, "M5_CONFIRMED_STRUCTURE_TIGHTEN");
assert.equal(m5Tighten.stopLoss, 4276);
assert.ok(m5Tighten.stopLoss < 4284.17, "SELL M5 structure must only tighten SL.");

const m5NeverLoosen = evaluateM5StructuralTrail({
  side: "SELL",
  bars: sellBars,
  afterTimestamp: 0,
  atOrBefore: 3_000,
  currentStop: 4275.0,
  lastStructuralStop: 4275.0,
  bid: 4268.8,
  ask: 4269.0,
  digits: 2,
  point: 0.01,
  stopsLevelTicks: 50,
  freezeLevelTicks: 50,
});
assert.equal(m5NeverLoosen.allowed, false);
assert.equal(m5NeverLoosen.reason, "NOT_STRICTLY_TIGHTER");

console.log("TREND_MANAGEMENT_EXIT_SIDE_BINDING=PASS");
console.log("TREND_PLUS6_BE_CHAIN=PASS");
console.log("TREND_PLUS10_PARTIAL_CHAIN=PASS");
console.log("TREND_FASTMOVE_CHAIN=PASS");
console.log("TREND_M5_STRUCTURAL_CHAIN=PASS");
console.log("TREND_STOP_NEVER_LOOSENS=PASS");
