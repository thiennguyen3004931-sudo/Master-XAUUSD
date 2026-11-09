import assert from "node:assert/strict";
import {
  evaluateFastMoveCounterfactual,
} from "../apps/api/src/services/phase7c-counterfactual-evaluator.service";

const base = {
  tradeKey: "LIVE:TREND:1:t1",
  positionId: "1",
  strategy: "TREND" as const,
  side: "BUY" as const,
  entryType: "IMMEDIATE" as const,
  regime: "TREND",
  entry: 100,
  actualExit: 108,
  actualNetPnl: 8,
  actualRealizedR: null,
  exactCorrelation: true,
  exactManagementEvidence: true,
  managementEvents: [],
};

const legacyOnly = evaluateFastMoveCounterfactual({
  ...base,
  orderedExitSidePrices: [
    { timestamp: 1_000, price: 100 },
    { timestamp: 2_000, price: 112 },
    { timestamp: 3_000, price: 120 },
    { timestamp: 4_000, price: 108 },
  ],
  orderedExitSideEvidenceComplete: true,
  alternativeGivebackPrice: 6,
});
assert.notEqual(
  legacyOnly.evidence.verdict,
  "EXACT",
  "Plain ordered prices must no longer manufacture EXACT; cycle timing plus broker ticks are required.",
);

const exact = evaluateFastMoveCounterfactual({
  ...base,
  managementExitSideSamples: [
    { timestamp: 1_050, price: 100 },
    { timestamp: 2_000, price: 112 },
    { timestamp: 3_000, price: 120 },
    { timestamp: 9_950, price: 108 },
  ],
  brokerExitSideTicks: [
    { timestamp: 1_000, sequence: 0, price: 99.9 },
    { timestamp: 1_050, sequence: 1, price: 100 },
    { timestamp: 2_000, sequence: 2, price: 112 },
    { timestamp: 2_500, sequence: 3, price: 110 },
    { timestamp: 3_000, sequence: 4, price: 120 },
    { timestamp: 3_100, sequence: 5, price: 113.5 },
    { timestamp: 9_950, sequence: 6, price: 108 },
    { timestamp: 10_000, sequence: 7, price: 108 },
  ],
  exactFastMovePathEvidenceComplete: true,
  alternativeGivebackPrice: 6,
} as any);
assert.equal(exact.evidence.verdict, "EXACT");
assert.equal(exact.shadowOutcome.exitPrice, 114);
assert.equal(exact.delta.exitPrice, 6);
assert.equal(exact.evidence.sources.includes("MANAGEMENT_SAMPLES_PLUS_BROKER_TICKS_COMPLETE"), true);

const priorStopHit = evaluateFastMoveCounterfactual({
  ...base,
  managementExitSideSamples: [
    { timestamp: 1_050, price: 100 },
    { timestamp: 2_000, price: 112 },
    { timestamp: 3_000, price: 120 },
    { timestamp: 9_950, price: 108 },
  ],
  brokerExitSideTicks: [
    { timestamp: 1_000, sequence: 0, price: 99.9 },
    { timestamp: 1_050, sequence: 1, price: 100 },
    { timestamp: 2_000, sequence: 2, price: 112 },
    { timestamp: 2_500, sequence: 3, price: 107.5 },
    { timestamp: 3_000, sequence: 4, price: 120 },
    { timestamp: 9_950, sequence: 5, price: 108 },
    { timestamp: 10_000, sequence: 6, price: 108 },
  ],
  exactFastMovePathEvidenceComplete: true,
  alternativeGivebackPrice: 4,
} as any);
assert.equal(priorStopHit.evidence.verdict, "EXACT");
assert.equal(priorStopHit.shadowOutcome.exitPrice, 108);
assert.equal(
  priorStopHit.shadowOutcome.exitPrice,
  108,
  "The tick hit between cycles must exit before the later 120 management sample can tighten the stop again.",
);

console.log("P6B_FASTMOVE_EXACT_PATH_TEST=PASS");
console.log("P6B_MANAGEMENT_CYCLE_TIMING_PRESERVED=PASS");
console.log("P6B_LEGACY_ORDERED_PRICES_FALSE_EXACT=REJECTED");
