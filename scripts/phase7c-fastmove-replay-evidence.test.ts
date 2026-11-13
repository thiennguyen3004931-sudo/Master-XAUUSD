import assert from "node:assert/strict";
import {
  buildPhase7CFastMoveReplayEvidence,
} from "../apps/api/src/services/phase7c-fastmove-replay-evidence.service";

const observed = {
  verdict: "COMPLETE_OBSERVED_WINDOW" as const,
  complete: true,
  prices: [
    { timestamp: 1_050, price: 100, sequence: 0 },
    { timestamp: 2_000, price: 112, sequence: 1 },
    { timestamp: 3_000, price: 120, sequence: 2 },
    { timestamp: 9_950, price: 108, sequence: 3 },
  ],
  source: {
    journalPath: "phase7c-executors/decision-observability/live/trend-exit-side-samples.jsonl",
    available: true,
    parsedRows: 4,
    malformedRows: 0,
    matchedRows: 4,
  },
  warnings: [],
};

const ticks = [
  { timestamp: 1_000, sequence: 0, bid: 99.9, ask: 100.1 },
  { timestamp: 1_050, sequence: 1, bid: 100.0, ask: 100.2 },
  { timestamp: 2_000, sequence: 2, bid: 112.0, ask: 112.2 },
  { timestamp: 2_500, sequence: 3, bid: 110.0, ask: 110.2 },
  { timestamp: 3_000, sequence: 4, bid: 120.0, ask: 120.2 },
  { timestamp: 3_100, sequence: 5, bid: 113.5, ask: 113.7 },
  { timestamp: 9_950, sequence: 6, bid: 108.0, ask: 108.2 },
  { timestamp: 10_000, sequence: 7, bid: 108.0, ask: 108.2 },
];

const exact = buildPhase7CFastMoveReplayEvidence({
  side: "BUY",
  openedAt: 1_000,
  closedAt: 10_000,
  observed,
  brokerTicks: ticks,
  boundaryToleranceMs: 120,
  sampleMatchToleranceMs: 0,
  priceTolerance: 1e-9,
});
assert.equal(exact.verdict, "EXACT_PATH");
assert.equal(exact.complete, true);
assert.equal(exact.managementSamples.length, 4);
assert.equal(exact.brokerTicks.length, 8);
assert.deepEqual(exact.warnings, []);

const missingObservedMatch = buildPhase7CFastMoveReplayEvidence({
  side: "BUY",
  openedAt: 1_000,
  closedAt: 10_000,
  observed,
  brokerTicks: ticks.filter((row) => row.timestamp !== 3_000),
  boundaryToleranceMs: 120,
  sampleMatchToleranceMs: 0,
  priceTolerance: 1e-9,
});
assert.equal(missingObservedMatch.verdict, "UNAVAILABLE");
assert.equal(missingObservedMatch.complete, false);
assert.equal(missingObservedMatch.warnings.includes("MANAGEMENT_SAMPLE_NOT_IN_BROKER_TICKS"), true);

const incompleteObserved = buildPhase7CFastMoveReplayEvidence({
  side: "BUY",
  openedAt: 1_000,
  closedAt: 10_000,
  observed: { ...observed, verdict: "UNAVAILABLE", complete: false },
  brokerTicks: ticks,
  boundaryToleranceMs: 120,
  sampleMatchToleranceMs: 0,
  priceTolerance: 1e-9,
});
assert.equal(incompleteObserved.verdict, "UNAVAILABLE");
assert.equal(incompleteObserved.complete, false);
assert.equal(incompleteObserved.warnings.includes("MANAGEMENT_OBSERVED_WINDOW_INCOMPLETE"), true);

console.log("P6B_FASTMOVE_REPLAY_EVIDENCE_TEST=PASS");
console.log("P6B_EXACT_PATH=MANAGEMENT_SAMPLES_PLUS_BROKER_TICKS");
console.log("P6B_FAIL_CLOSED_ON_MISSING_SAMPLE_MATCH=PASS");
