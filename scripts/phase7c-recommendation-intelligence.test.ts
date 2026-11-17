import assert from "node:assert/strict";
import { buildPhase7CRecommendationSnapshotFromEvidence } from "../apps/api/src/services/phase7c-recommendation-intelligence.service";

function metric(key: string, sampleSize = 12, expectancy = 10) {
  return {
    key,
    sampleSize,
    wins: 8,
    losses: 4,
    breakeven: 0,
    netPnl: expectancy * sampleSize,
    expectancy,
    winRatePercent: 66.7,
    profitFactor: 2,
  };
}

const rows = Array.from({ length: 12 }, (_, index) => ({
  tradeKey: `LIVE:TREND:P${index}:T${index}`,
  positionId: `P${index}`,
  strategy: "TREND",
  regime: "TREND",
  entryType: "IMMEDIATE",
  correlation: { verdict: "EXACT", evidence: [`decision:${index}`] },
  quality: { exactCorrelation: true, exactManagementEvidence: true },
  rules: { passed: ["RULE_A"], blocked: [] },
  management: {
    evidence: "EXACT",
    events: [
      { family: "FAST_MOVE_TIGHTEN" },
      { family: "BREAK_EVEN" },
      { family: "M5_STRUCTURAL_TIGHTEN" },
    ],
  },
}));

const effectiveness = {
  schemaVersion: "phase7c-performance-effectiveness-v1",
  generatedAt: 1000,
  source: "PHASE7C_PERFORMANCE_EFFECTIVENESS",
  readOnly: true,
  safety: {},
  summary: {
    totalRows: 12,
    exactRows: 12,
    excursionQualifiedRows: 0,
    managementQualifiedRows: 12,
    evidenceCoveragePercent: 100,
  },
  aggregates: {
    strategy: [metric("TREND")],
    entryType: [metric("IMMEDIATE")],
    regime: [metric("TREND")],
    rule: [metric("RULE_A")],
    management: [
      metric("FAST_MOVE_TIGHTEN"),
      metric("BREAK_EVEN"),
      metric("M5_STRUCTURAL_TIGHTEN"),
    ],
    excursion: {
      sampleSize: 0,
      averageMfePrice: null,
      averageMaePrice: null,
      averageMfeR: null,
      averageMaeR: null,
      averageRealizedR: null,
      averagePeakToExitGivebackPrice: null,
    },
    fastMove: { exactSampleSize: 12, triggeredRows: 12, handoffRows: 0, averageLockedProfitPrice: 10 },
  },
  rows,
  notes: [],
} as any;

function scenario({
  id,
  family,
  verdict,
  ruleId = null,
  managementFamily = null,
  lockedDelta = null,
  exitDelta = null,
}: {
  id: string;
  family: "RULE_OBSERVATION" | "MANAGEMENT_EXIT_POLICY" | "FAST_MOVE_GIVEBACK";
  verdict: "EXACT" | "BOUNDED" | "UNAVAILABLE";
  ruleId?: string | null;
  managementFamily?: string | null;
  lockedDelta?: number | null;
  exitDelta?: number | null;
}) {
  return {
    scenarioId: id,
    tradeKey: id,
    positionId: id,
    strategy: "TREND",
    regime: "TREND",
    entryType: "IMMEDIATE",
    family,
    evidence: { verdict, sources: [] },
    baseline: { ruleId, managementFamily },
    alternative: {},
    delta: {
      lockedProfitPrice: lockedDelta,
      exitPrice: exitDelta,
      netPnl: null,
      realizedR: null,
    },
    quality: { warnings: [] },
    safety: {},
  };
}

const counterfactual = {
  schemaVersion: "phase7c-counterfactual-intelligence-v1",
  generatedAt: 1000,
  source: "PHASE7C_COUNTERFACTUAL_INTELLIGENCE",
  readOnly: true,
  shadowOnly: true,
  safety: {},
  summary: {
    tradeCount: 12,
    scenarioCount: 7,
    exactCount: 1,
    boundedCount: 5,
    unavailableCount: 1,
    evidenceQualifiedCount: 6,
    evidenceCoveragePercent: 85.7,
  },
  aggregates: { family: [] },
  scenarios: [
    scenario({
      id: "rule-a",
      family: "RULE_OBSERVATION",
      verdict: "UNAVAILABLE",
      ruleId: "RULE_A",
    }),
    scenario({
      id: "fm-positive",
      family: "MANAGEMENT_EXIT_POLICY",
      verdict: "BOUNDED",
      managementFamily: "FAST_MOVE_TIGHTEN",
      lockedDelta: 2,
    }),
    scenario({
      id: "fm-exact-positive",
      family: "FAST_MOVE_GIVEBACK",
      verdict: "EXACT",
      lockedDelta: 3,
    }),
    scenario({
      id: "be-positive",
      family: "MANAGEMENT_EXIT_POLICY",
      verdict: "BOUNDED",
      managementFamily: "BREAK_EVEN",
      exitDelta: 1,
    }),
    scenario({
      id: "be-negative",
      family: "MANAGEMENT_EXIT_POLICY",
      verdict: "BOUNDED",
      managementFamily: "BREAK_EVEN",
      exitDelta: -1,
    }),
    scenario({
      id: "m5-zero",
      family: "MANAGEMENT_EXIT_POLICY",
      verdict: "BOUNDED",
      managementFamily: "M5_STRUCTURAL_TIGHTEN",
      exitDelta: 0,
    }),
    scenario({
      id: "fm-grid",
      family: "FAST_MOVE_GIVEBACK",
      verdict: "BOUNDED",
      lockedDelta: 2,
    }),
  ],
  notes: [],
} as any;

const snapshot = buildPhase7CRecommendationSnapshotFromEvidence({
  effectiveness,
  counterfactual,
  generatedAt: 1234,
});

assert.equal(snapshot.schemaVersion, "phase7c-recommendation-intelligence-v1");
assert.equal(snapshot.generatedAt, 1234);
assert.equal(snapshot.readOnly, true);
assert.equal(snapshot.advisoryOnly, true);
assert.equal(snapshot.safety.autoApply, false);
assert.equal(snapshot.safety.autoRetune, false);
assert.equal(snapshot.evidenceScoreIsNotProbability, true);

const rule = snapshot.recommendations.find((item) => item.targetScope === "RULE" && item.targetKey === "RULE_A");
assert.ok(rule);
assert.equal(rule.action, "COLLECT_MORE_EVIDENCE");
assert.ok(rule.reasonCodes.includes("COUNTERFACTUAL_RULE_REPLAY_UNAVAILABLE"));

const entry = snapshot.recommendations.find((item) => item.targetScope === "ENTRY_TYPE" && item.targetKey === "IMMEDIATE");
assert.ok(entry);
assert.equal(entry.action, "COLLECT_MORE_EVIDENCE");
assert.ok(entry.reasonCodes.includes("COUNTERFACTUAL_ENTRY_REPLAY_UNAVAILABLE"));

const fastMove = snapshot.recommendations.find((item) => item.targetScope === "MANAGEMENT" && item.targetKey === "FAST_MOVE_TIGHTEN");
assert.ok(fastMove);
assert.equal(fastMove.counterfactual.verdict, "BOUNDED");
assert.equal(fastMove.counterfactual.exactCount, 1);
assert.ok(fastMove.counterfactual.boundedCount >= 1);
assert.equal(fastMove.action, "REVIEW_CHANGE");
assert.equal(fastMove.confidence, "MEDIUM");
assert.equal(fastMove.counterfactual.counterfactualNetPnlDelta, null);
assert.equal(fastMove.counterfactual.counterfactualRealizedRDelta, null);
assert.ok(fastMove.reasonCodes.includes("BOUNDED_DIRECTIONAL_EVIDENCE"));
assert.ok(fastMove.reasonCodes.includes("PNL_NOT_PROVABLE"));
assert.ok(fastMove.reasonCodes.includes("REALIZED_R_NOT_PROVABLE"));

const conflict = snapshot.recommendations.find((item) => item.targetScope === "MANAGEMENT" && item.targetKey === "BREAK_EVEN");
assert.ok(conflict);
assert.equal(conflict.counterfactual.conflict, true);
assert.notEqual(conflict.action, "REVIEW_CHANGE");
assert.ok(conflict.reasonCodes.includes("EVIDENCE_CONFLICT"));

const keep = snapshot.recommendations.find((item) => item.targetScope === "MANAGEMENT" && item.targetKey === "M5_STRUCTURAL_TIGHTEN");
assert.ok(keep);
assert.equal(keep.action, "KEEP_CURRENT");
assert.ok(keep.reasonCodes.includes("NO_PROVEN_IMPROVEMENT"));

assert.equal(new Set(snapshot.recommendations.map((item) => `${item.targetScope}:${item.targetKey}`)).size, snapshot.recommendations.length);
assert.equal(snapshot.summary.candidateCount, snapshot.recommendations.length);
assert.equal(snapshot.summary.reviewChangeCount, snapshot.recommendations.filter((item) => item.action === "REVIEW_CHANGE").length);
assert.equal(snapshot.summary.keepCurrentCount, snapshot.recommendations.filter((item) => item.action === "KEEP_CURRENT").length);
assert.equal(snapshot.summary.collectMoreEvidenceCount, snapshot.recommendations.filter((item) => item.action === "COLLECT_MORE_EVIDENCE").length);
assert.equal(snapshot.summary.unavailableCount, snapshot.recommendations.filter((item) => item.action === "UNAVAILABLE").length);

console.log("PHASE7C_RECOMMENDATION_INTELLIGENCE_COMPOSITION=PASS");
