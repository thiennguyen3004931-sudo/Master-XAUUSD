import assert from "node:assert/strict";
import {
  PHASE7C_PERFORMANCE_EFFECTIVENESS_SCHEMA_VERSION,
  type Phase7CPerformanceEffectivenessRow,
} from "../apps/api/src/contracts/phase7c-performance-effectiveness.schema";
import { PHASE7C_COUNTERFACTUAL_INTELLIGENCE_SCHEMA_VERSION } from "../apps/api/src/contracts/phase7c-counterfactual-intelligence.schema";
import { buildPhase7CCounterfactualSnapshotFromRows } from "../apps/api/src/services/phase7c-counterfactual-intelligence.service";

function baseRow(overrides: Partial<Phase7CPerformanceEffectivenessRow> = {}): Phase7CPerformanceEffectivenessRow {
  return {
    schemaVersion: PHASE7C_PERFORMANCE_EFFECTIVENESS_SCHEMA_VERSION,
    tradeKey: "LIVE:TREND:1:t1",
    positionId: "1",
    symbol: "XAUUSD",
    accountMode: "LIVE",
    strategy: "TREND",
    side: "BUY",
    entryType: "IMMEDIATE",
    regime: "TREND",
    openedAt: 1_000,
    closedAt: 10_000,
    entry: 100,
    exit: 108,
    initialVolume: 0.03,
    netPnl: 8,
    correlation: { verdict: "EXACT", evidence: ["POSITION", "ORDER", "SIGNAL"] },
    rules: { passed: ["RULE_A"], blocked: ["RULE_B"] },
    excursion: {
      evidence: "COMPLETE_M5_WINDOW",
      initialRiskPrice: 10,
      mfePrice: 20,
      maePrice: 2,
      mfeR: 2,
      maeR: 0.2,
      realizedR: 0.8,
      peakToExitGivebackPrice: 12,
    },
    management: {
      evidence: "EXACT",
      events: [
        {
          family: "BREAK_EVEN",
          timestamp: 2_000,
          stopLoss: 100,
          price: 106,
          source: "trend-decisions.jsonl",
          eventId: "be-1",
        },
        {
          family: "FAST_MOVE_TIGHTEN",
          timestamp: 3_000,
          stopLoss: 110,
          price: 120,
          source: "trend-decisions.jsonl",
          eventId: "fm-1",
        },
      ],
    },
    fastMove: {
      current: { activationPrice: 10, givebackPrice: 10, source: "LIVE_BID_ASK" },
      triggered: true,
      handoffToM5: false,
    },
    quality: {
      exactCorrelation: true,
      completeExcursionEvidence: true,
      exactManagementEvidence: true,
      warnings: [],
    },
    ...overrides,
  };
}

const rows: Phase7CPerformanceEffectivenessRow[] = [
  baseRow(),
  baseRow({
    tradeKey: "LIVE:SIDEWAY:2:t2",
    positionId: "2",
    strategy: "SIDEWAY",
    side: "SELL",
    entryType: "PULLBACK",
    regime: "SIDEWAY",
    entry: 200,
    exit: 196,
    netPnl: 4,
    rules: { passed: [], blocked: [] },
    management: { evidence: "EXACT", events: [] },
    fastMove: {
      current: { activationPrice: 10, givebackPrice: 10, source: "LIVE_BID_ASK" },
      triggered: false,
      handoffToM5: false,
    },
  }),
];

const snapshot = buildPhase7CCounterfactualSnapshotFromRows({
  rows,
  generatedAt: 55_555,
});

assert.equal(snapshot.schemaVersion, PHASE7C_COUNTERFACTUAL_INTELLIGENCE_SCHEMA_VERSION);
assert.equal(snapshot.generatedAt, 55_555);
assert.equal(snapshot.source, "PHASE7C_COUNTERFACTUAL_INTELLIGENCE");
assert.equal(snapshot.readOnly, true);
assert.equal(snapshot.shadowOnly, true);
assert.deepEqual(snapshot.summary, {
  tradeCount: 2,
  scenarioCount: 12,
  exactCount: 0,
  boundedCount: 6,
  unavailableCount: 6,
  evidenceQualifiedCount: 6,
  evidenceCoveragePercent: 50,
});

const fastMove = snapshot.scenarios.filter((scenario) => scenario.family === "FAST_MOVE_GIVEBACK");
assert.equal(fastMove.length, 8);
assert.deepEqual(
  [...new Set(fastMove.map((scenario) => scenario.alternative.givebackPrice))].sort((a, b) => Number(a) - Number(b)),
  [4, 6, 8, 12],
);
assert.equal(fastMove.every((scenario) => scenario.baseline.activationPrice === 10), true);
assert.equal(fastMove.every((scenario) => scenario.baseline.givebackPrice === 10), true);

const trendFastMove = fastMove.filter((scenario) => scenario.tradeKey === "LIVE:TREND:1:t1");
assert.equal(trendFastMove.every((scenario) => scenario.evidence.verdict === "BOUNDED"), true);
assert.deepEqual(
  trendFastMove.map((scenario) => scenario.delta.lockedProfitPrice),
  [6, 4, 2, -2],
);
assert.equal(trendFastMove.every((scenario) => scenario.shadowOutcome.exitPrice === null), true);
assert.equal(trendFastMove.every((scenario) => scenario.shadowOutcome.netPnl === null), true);

const sidewayFastMove = fastMove.filter((scenario) => scenario.tradeKey === "LIVE:SIDEWAY:2:t2");
assert.equal(sidewayFastMove.every((scenario) => scenario.evidence.verdict === "UNAVAILABLE"), true);
assert.equal(sidewayFastMove.every((scenario) => scenario.delta.lockedProfitPrice === null), true);

const ruleScenarios = snapshot.scenarios.filter((scenario) => scenario.family === "RULE_OBSERVATION");
assert.equal(ruleScenarios.length, 2);
assert.deepEqual(ruleScenarios.map((scenario) => scenario.alternative.ruleId).sort(), ["RULE_A", "RULE_B"]);
assert.equal(ruleScenarios.every((scenario) => scenario.evidence.verdict === "UNAVAILABLE"), true);
assert.equal(ruleScenarios.every((scenario) => scenario.shadowOutcome.netPnl === null), true);
assert.equal(ruleScenarios.every((scenario) => scenario.delta.netPnl === null), true);
assert.equal(ruleScenarios.every((scenario) => scenario.quality.warnings.includes("COUNTERFACTUAL_RULE_OUTCOME_NOT_PROVABLE")), true);

const managementScenarios = snapshot.scenarios.filter((scenario) => scenario.family === "MANAGEMENT_EXIT_POLICY");
assert.equal(managementScenarios.length, 2);
assert.deepEqual(
  managementScenarios.map((scenario) => scenario.baseline.managementFamily).sort(),
  ["BREAK_EVEN", "FAST_MOVE_TIGHTEN"],
);
assert.equal(managementScenarios.every((scenario) => scenario.evidence.verdict === "BOUNDED"), true);
assert.equal(managementScenarios.every((scenario) => scenario.delta.netPnl === null), true);

const trendScenario = snapshot.scenarios.find((scenario) => scenario.tradeKey === "LIVE:TREND:1:t1");
assert.ok(trendScenario);
assert.equal(trendScenario.entryType, "IMMEDIATE");
assert.equal(trendScenario.regime, "TREND");

const fastMoveAggregate = snapshot.aggregates.family.find((aggregate) => aggregate.family === "FAST_MOVE_GIVEBACK");
assert.ok(fastMoveAggregate);
assert.deepEqual(fastMoveAggregate, {
  family: "FAST_MOVE_GIVEBACK",
  scenarioCount: 8,
  exactCount: 0,
  boundedCount: 4,
  unavailableCount: 4,
  averageDeltaExitPrice: null,
  averageDeltaLockedProfitPrice: 2.5,
  improvementCount: 3,
  deteriorationCount: 1,
});


for (const scenario of snapshot.scenarios) {
  assert.equal(scenario.safety.autoApply, false);
  assert.equal(scenario.safety.autoRetune, false);
  assert.equal(scenario.safety.orderMutation, false);
  assert.equal(scenario.safety.positionMutation, false);
}
assert.equal(snapshot.notes.some((note) => note.includes("M5 OHLC")), true);
assert.equal(snapshot.notes.some((note) => note.includes("recommendation")), true);

console.log("P4_COUNTERFACTUAL_INTELLIGENCE_TEST=PASS");
console.log("P4_FAST_MOVE_SHADOW_GRID=4_6_8_12");
console.log("P4_RULE_COUNTERFACTUAL_OUTCOME_WITHOUT_REPLAY=UNAVAILABLE");
console.log("P4_RULE_COUNTERFACTUAL_PNL_INFERENCE=NONE");
console.log("P4_M5_OHLC_ORDER_INFERENCE=NONE");
