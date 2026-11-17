import assert from "node:assert/strict";
import { PHASE7C_COUNTERFACTUAL_INTELLIGENCE_SCHEMA_VERSION } from "../apps/api/src/contracts/phase7c-counterfactual-intelligence.schema";
import { evaluateFastMoveCounterfactual } from "../apps/api/src/services/phase7c-counterfactual-evaluator.service";

const exact = evaluateFastMoveCounterfactual({
  tradeKey: "LIVE:TREND:1:t1",
  positionId: "1",
  strategy: "TREND",
  side: "BUY",
  entry: 100,
  actualExit: 112,
  actualNetPnl: 12,
  actualRealizedR: 1.2,
  exactCorrelation: true,
  exactManagementEvidence: true,
  managementEvents: [],
  managementExitSideSamples: [
    { timestamp: 1_000, price: 100 },
    { timestamp: 2_000, price: 110 },
    { timestamp: 3_000, price: 118 },
    { timestamp: 4_000, price: 116 },
    { timestamp: 5_000, price: 112 },
  ],
  brokerExitSideTicks: [
    { timestamp: 1_000, sequence: 0, price: 100 },
    { timestamp: 2_000, sequence: 1, price: 110 },
    { timestamp: 3_000, sequence: 2, price: 118 },
    { timestamp: 4_000, sequence: 3, price: 116 },
    { timestamp: 5_000, sequence: 4, price: 112 },
  ],
  exactFastMovePathEvidenceComplete: true,
  alternativeGivebackPrice: 6,
});

assert.equal(exact.schemaVersion, PHASE7C_COUNTERFACTUAL_INTELLIGENCE_SCHEMA_VERSION);
assert.equal(exact.family, "FAST_MOVE_GIVEBACK");
assert.equal(exact.mode, "SHADOW_ONLY");
assert.equal(exact.evidence.verdict, "EXACT");
assert.equal(exact.evidence.sources.includes("MANAGEMENT_SAMPLES_PLUS_BROKER_TICKS_COMPLETE"), true);
assert.equal(exact.baseline.activationPrice, 10);
assert.equal(exact.baseline.givebackPrice, 10);
assert.equal(exact.alternative.givebackPrice, 6);
assert.equal(exact.shadowOutcome.exitPrice, 112);
assert.equal(exact.shadowOutcome.lockedProfitPrice, 12);
assert.equal(exact.delta.exitPrice, 0);
assert.equal(exact.delta.lockedProfitPrice, 0);
assert.equal(exact.delta.netPnl, null);
assert.equal(exact.delta.realizedR, null);

const incompleteOrdered = evaluateFastMoveCounterfactual({
  tradeKey: "LIVE:TREND:1b:t1b",
  positionId: "1b",
  strategy: "TREND",
  side: "BUY",
  entry: 100,
  actualExit: 112,
  actualNetPnl: 12,
  actualRealizedR: null,
  exactCorrelation: true,
  exactManagementEvidence: false,
  managementEvents: [],
  orderedExitSideEvidenceComplete: false,
  orderedExitSidePrices: [
    { timestamp: 3_000, price: 118 },
    { timestamp: 5_000, price: 112 },
  ],
  alternativeGivebackPrice: 6,
});

assert.equal(incompleteOrdered.evidence.verdict, "UNAVAILABLE");
assert.equal(incompleteOrdered.shadowOutcome.exitPrice, null);
assert.equal(incompleteOrdered.delta.exitPrice, null);
assert.equal(
  incompleteOrdered.quality.warnings.includes("ORDERED_EXIT_SIDE_EVIDENCE_INCOMPLETE"),
  true,
);

const legacyComplete = evaluateFastMoveCounterfactual({
  tradeKey: "LIVE:TREND:1c:t1c",
  positionId: "1c",
  strategy: "TREND",
  side: "BUY",
  entry: 100,
  actualExit: 112,
  actualNetPnl: 12,
  actualRealizedR: null,
  exactCorrelation: true,
  exactManagementEvidence: false,
  managementEvents: [],
  orderedExitSideEvidenceComplete: true,
  orderedExitSidePrices: [
    { timestamp: 1_000, price: 100 },
    { timestamp: 2_000, price: 110 },
    { timestamp: 3_000, price: 118 },
    { timestamp: 5_000, price: 112 },
  ],
  alternativeGivebackPrice: 6,
});

assert.notEqual(legacyComplete.evidence.verdict, "EXACT");
assert.equal(
  legacyComplete.quality.warnings.includes("ORDERED_EXIT_SIDE_PRICES_REQUIRE_BROKER_TICKS"),
  true,
);

const bounded = evaluateFastMoveCounterfactual({
  tradeKey: "LIVE:TREND:2:t2",
  positionId: "2",
  strategy: "TREND",
  side: "BUY",
  entry: 100,
  actualExit: 108,
  actualNetPnl: 8,
  actualRealizedR: null,
  exactCorrelation: true,
  exactManagementEvidence: true,
  managementEvents: [
    {
      family: "FAST_MOVE_TIGHTEN",
      timestamp: 2_000,
      stopLoss: 110,
      price: 120,
      source: "trend-decisions.jsonl",
      eventId: "fm-1",
    },
  ],
  orderedExitSidePrices: [],
  alternativeGivebackPrice: 6,
});

assert.equal(bounded.evidence.verdict, "BOUNDED");
assert.equal(bounded.actualOutcome.lockedProfitPrice, 10);
assert.equal(bounded.shadowOutcome.lockedProfitPrice, 14);
assert.equal(bounded.delta.lockedProfitPrice, 4);
assert.equal(bounded.shadowOutcome.exitPrice, null);
assert.equal(bounded.shadowOutcome.netPnl, null);
assert.equal(bounded.delta.netPnl, null);
assert.equal(bounded.quality.warnings.includes("COUNTERFACTUAL_EXIT_NOT_PROVABLE"), true);

const unavailable = evaluateFastMoveCounterfactual({
  tradeKey: "LIVE:SIDEWAY:3:t3",
  positionId: "3",
  strategy: "SIDEWAY",
  side: "SELL",
  entry: 200,
  actualExit: 195,
  actualNetPnl: 5,
  actualRealizedR: null,
  exactCorrelation: false,
  exactManagementEvidence: false,
  managementEvents: [],
  orderedExitSidePrices: [],
  alternativeGivebackPrice: 8,
});

assert.equal(unavailable.evidence.verdict, "UNAVAILABLE");
assert.equal(unavailable.shadowOutcome.exitPrice, null);
assert.equal(unavailable.shadowOutcome.lockedProfitPrice, null);
assert.equal(unavailable.delta.exitPrice, null);
assert.equal(unavailable.delta.lockedProfitPrice, null);
assert.equal(unavailable.quality.warnings.includes("CORRELATION_NOT_EXACT"), true);

for (const scenario of [exact, incompleteOrdered, legacyComplete, bounded, unavailable]) {
  assert.equal(scenario.safety.readOnly, true);
  assert.equal(scenario.safety.shadowOnly, true);
  assert.equal(scenario.safety.strategyMutation, false);
  assert.equal(scenario.safety.riskMutation, false);
  assert.equal(scenario.safety.orderMutation, false);
  assert.equal(scenario.safety.positionMutation, false);
  assert.equal(scenario.safety.modeMutation, false);
  assert.equal(scenario.safety.armMutation, false);
  assert.equal(scenario.safety.autoApply, false);
  assert.equal(scenario.safety.autoRetune, false);
  assert.equal(scenario.safety.liveTestOrder, false);
}

console.log("P4_COUNTERFACTUAL_EVALUATOR_TEST=PASS");
console.log("P4_EVIDENCE_VERDICTS=EXACT_BOUNDED_UNAVAILABLE");
console.log("P4_EXACT_REPLAY_REQUIRES_CYCLE_PLUS_TICK_EVIDENCE=PASS");
console.log("P4_LEGACY_ORDERED_PRICES_FALSE_EXACT=REJECTED");
console.log("P4_COUNTERFACTUAL_PNL_INFERENCE=NONE_WITHOUT_EXECUTION_EVIDENCE");
