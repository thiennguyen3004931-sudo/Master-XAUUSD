import assert from "node:assert/strict";
import {
  PHASE7C_PERFORMANCE_EFFECTIVENESS_SCHEMA_VERSION,
  type Phase7CPerformanceEffectivenessRow,
} from "../apps/api/src/contracts/phase7c-performance-effectiveness.schema";
import { buildPhase7CPerformanceEffectivenessSnapshotFromRows } from "../apps/api/src/services/phase7c-performance-effectiveness.service";

function row(overrides: Partial<Phase7CPerformanceEffectivenessRow> & Pick<Phase7CPerformanceEffectivenessRow, "tradeKey" | "positionId" | "strategy" | "netPnl">): Phase7CPerformanceEffectivenessRow {
  return {
    schemaVersion: PHASE7C_PERFORMANCE_EFFECTIVENESS_SCHEMA_VERSION,
    tradeKey: overrides.tradeKey,
    positionId: overrides.positionId,
    symbol: "XAUUSD",
    accountMode: "LIVE",
    strategy: overrides.strategy,
    side: "BUY",
    entryType: "IMMEDIATE",
    regime: overrides.strategy,
    openedAt: 1_000,
    closedAt: 2_000,
    entry: 100,
    exit: 100 + overrides.netPnl,
    initialVolume: 0.03,
    netPnl: overrides.netPnl,
    correlation: { verdict: "EXACT", evidence: ["POSITION"] },
    rules: { passed: ["RULE_A"], blocked: [] },
    excursion: {
      evidence: "COMPLETE_M5_WINDOW",
      initialRiskPrice: 10,
      mfePrice: 20,
      maePrice: 2,
      mfeR: 2,
      maeR: 0.2,
      realizedR: overrides.netPnl / 10,
      peakToExitGivebackPrice: 4,
    },
    management: { evidence: "EXACT", events: [] },
    fastMove: {
      current: {
        activationPrice: 10,
        givebackPrice: overrides.strategy === "TREND" ? 6 : 4,
        source: "LIVE_BID_ASK",
      },
      triggered: false,
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
  row({
    tradeKey: "t1",
    positionId: "1",
    strategy: "TREND",
    netPnl: 10,
    rules: { passed: ["RULE_A"], blocked: [] },
    management: {
      evidence: "EXACT",
      events: [
        { family: "BREAK_EVEN", timestamp: 1_200, stopLoss: 100, price: null, source: "trend.jsonl", eventId: "be1" },
        { family: "FAST_MOVE_TIGHTEN", timestamp: 1_300, stopLoss: 104, price: 110, source: "trend.jsonl", eventId: "fm1" },
        { family: "FAST_MOVE_HANDOFF_M5_STRUCTURE", timestamp: 1_400, stopLoss: null, price: 108, source: "trend.jsonl", eventId: "handoff1" },
      ],
    },
    fastMove: {
      current: { activationPrice: 10, givebackPrice: 6, source: "LIVE_BID_ASK" },
      triggered: true,
      handoffToM5: true,
    },
  }),
  row({
    tradeKey: "t2",
    positionId: "2",
    strategy: "TREND",
    netPnl: -5,
    excursion: {
      evidence: "COMPLETE_M5_WINDOW",
      initialRiskPrice: 10,
      mfePrice: 12,
      maePrice: 8,
      mfeR: 1.2,
      maeR: 0.8,
      realizedR: -0.5,
      peakToExitGivebackPrice: 3,
    },
  }),
  row({
    tradeKey: "s1",
    positionId: "3",
    strategy: "SIDEWAY",
    netPnl: 6,
    entry: 200,
    exit: 206,
    rules: { passed: ["RULE_B"], blocked: [] },
    excursion: {
      evidence: "INCOMPLETE",
      initialRiskPrice: null,
      mfePrice: null,
      maePrice: null,
      mfeR: null,
      maeR: null,
      realizedR: null,
      peakToExitGivebackPrice: null,
    },
    management: {
      evidence: "EXACT",
      events: [
        { family: "PARTIAL_CLOSE", timestamp: 1_200, stopLoss: null, price: null, source: "sideway.jsonl", eventId: "partial1" },
        { family: "FAST_MOVE_TIGHTEN", timestamp: 1_300, stopLoss: 206, price: 210, source: "sideway.jsonl", eventId: "fm2" },
      ],
    },
    fastMove: {
      current: { activationPrice: 10, givebackPrice: 4, source: "LIVE_BID_ASK" },
      triggered: true,
      handoffToM5: false,
    },
    quality: {
      exactCorrelation: true,
      completeExcursionEvidence: false,
      exactManagementEvidence: true,
      warnings: ["M5_WINDOW_INCOMPLETE"],
    },
  }),
  row({
    tradeKey: "r1",
    positionId: "5",
    strategy: "REVERSAL",
    netPnl: 7,
    entryType: "PULLBACK",
    regime: "REVERSAL",
    rules: { passed: ["REVERSAL_CHOCH_PATTERN_STRUCTURE_NO_SUPERTREND"], blocked: [] },
    excursion: {
      evidence: "UNAVAILABLE",
      initialRiskPrice: null,
      mfePrice: null,
      maePrice: null,
      mfeR: null,
      maeR: null,
      realizedR: null,
      peakToExitGivebackPrice: null,
    },
    management: { evidence: "UNMATCHED", events: [] },
    quality: {
      exactCorrelation: true,
      completeExcursionEvidence: false,
      exactManagementEvidence: false,
      warnings: ["MANAGEMENT_UNMATCHED"],
    },
  }),
  row({
    tradeKey: "ambiguous",
    positionId: "4",
    strategy: "TREND",
    netPnl: 100,
    correlation: { verdict: "AMBIGUOUS", evidence: [] },
    quality: {
      exactCorrelation: false,
      completeExcursionEvidence: true,
      exactManagementEvidence: true,
      warnings: ["CORRELATION_NOT_EXACT"],
    },
  }),
];

const snapshot = buildPhase7CPerformanceEffectivenessSnapshotFromRows({
  rows,
  generatedAt: 9_999,
});

assert.equal(snapshot.generatedAt, 9_999);
assert.equal(snapshot.readOnly, true);
assert.deepEqual(snapshot.summary, {
  totalRows: 5,
  exactRows: 4,
  excursionQualifiedRows: 2,
  managementQualifiedRows: 3,
  evidenceCoveragePercent: 80,
});

const trend = snapshot.aggregates.strategy.find((bucket) => bucket.key === "TREND");
assert.ok(trend);
assert.equal(trend.sampleSize, 2);
assert.equal(trend.netPnl, 5);
assert.equal(trend.expectancy, 2.5);
assert.equal(trend.winRatePercent, 50);
assert.equal(trend.profitFactor, 2);

const sideway = snapshot.aggregates.strategy.find((bucket) => bucket.key === "SIDEWAY");
assert.ok(sideway);
assert.equal(sideway.sampleSize, 1);
assert.equal(sideway.netPnl, 6);
assert.equal(sideway.expectancy, 6);

const reversal = snapshot.aggregates.strategy.find((bucket) => bucket.key === "REVERSAL");
assert.ok(reversal);
assert.equal(reversal.sampleSize, 1);
assert.equal(reversal.netPnl, 7);
assert.equal(reversal.expectancy, 7);

const ruleA = snapshot.aggregates.rule.find((bucket) => bucket.key === "RULE_A");
assert.ok(ruleA);
assert.equal(ruleA.sampleSize, 2);
assert.equal(ruleA.expectancy, 2.5);
const ruleB = snapshot.aggregates.rule.find((bucket) => bucket.key === "RULE_B");
assert.ok(ruleB);
assert.equal(ruleB.sampleSize, 1);

assert.deepEqual(snapshot.aggregates.excursion, {
  sampleSize: 2,
  averageMfePrice: 16,
  averageMaePrice: 5,
  averageMfeR: 1.6,
  averageMaeR: 0.5,
  averageRealizedR: 0.25,
  averagePeakToExitGivebackPrice: 3.5,
});

const fastMoveAssociation = snapshot.aggregates.management.find((bucket) => bucket.key === "FAST_MOVE_TIGHTEN");
assert.ok(fastMoveAssociation);
assert.equal(fastMoveAssociation.sampleSize, 2);
assert.equal(fastMoveAssociation.netPnl, 16);
assert.equal(fastMoveAssociation.expectancy, 8);
assert.deepEqual(snapshot.aggregates.fastMove, {
  exactSampleSize: 4,
  triggeredRows: 2,
  handoffRows: 1,
  averageLockedProfitPrice: 5,
});

assert.equal(snapshot.safety.runtimeMutation, false);
assert.equal(snapshot.safety.autoRetune, false);
assert.equal(snapshot.notes.some((note) => note.includes("association")), true);

console.log("P3_PERFORMANCE_EFFECTIVENESS_TEST=PASS");
console.log("P3_AGGREGATES_EXACT_CORRELATION_ONLY=TRUE");
console.log("P3_MANAGEMENT_CAUSALITY=ASSOCIATION_ONLY");
