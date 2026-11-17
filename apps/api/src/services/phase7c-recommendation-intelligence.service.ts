import {
  PHASE7C_RECOMMENDATION_INTELLIGENCE_SCHEMA_VERSION,
  phase7CRecommendationSafety,
  type Phase7CRecommendationCandidate,
  type Phase7CRecommendationCounterfactualEvidence,
  type Phase7CRecommendationObservedEffectiveness,
  type Phase7CRecommendationP4Verdict,
  type Phase7CRecommendationReasonCode,
  type Phase7CRecommendationSnapshot,
  type Phase7CRecommendationTargetScope,
} from "../contracts/phase7c-recommendation-intelligence.schema";
import type {
  Phase7CPerformanceEffectivenessMetricBucket,
  Phase7CPerformanceEffectivenessRow,
  Phase7CPerformanceEffectivenessSnapshot,
} from "../contracts/phase7c-performance-effectiveness.schema";
import type {
  Phase7CCounterfactualScenario,
  Phase7CCounterfactualSnapshot,
} from "../contracts/phase7c-counterfactual-intelligence.schema";
import { getPhase7CPerformanceEffectivenessSnapshot } from "./phase7c-performance-effectiveness.service";
import {
  buildPhase7CCounterfactualSnapshotFromRowsWithEvidence,
  runtimeFastMoveEvidenceProvider,
} from "./phase7c-counterfactual-intelligence.service";
import {
  evaluatePhase7CRecommendationCandidate,
  MIN_SAMPLE_FOR_HIGH_CONFIDENCE,
  MIN_SAMPLE_FOR_REVIEW,
} from "./phase7c-recommendation-evaluator.service";

export interface Phase7CRecommendationEvidenceInput {
  effectiveness: Phase7CPerformanceEffectivenessSnapshot;
  counterfactual: Phase7CCounterfactualSnapshot;
  generatedAt?: number;
}

export interface Phase7CRecommendationQuery {
  days?: number;
  symbol?: string;
  limit?: number;
}

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function exactRow(row: Phase7CPerformanceEffectivenessRow): boolean {
  return row.correlation.verdict === "EXACT" && row.quality.exactCorrelation === true;
}

function observed(
  bucket: Phase7CPerformanceEffectivenessMetricBucket,
): Phase7CRecommendationObservedEffectiveness {
  return {
    sampleSize: bucket.sampleSize,
    wins: bucket.wins,
    losses: bucket.losses,
    breakeven: bucket.breakeven,
    netPnl: bucket.netPnl,
    expectancy: bucket.expectancy,
    winRatePercent: bucket.winRatePercent,
    profitFactor: bucket.profitFactor,
  };
}

function candidateRows(
  rows: readonly Phase7CPerformanceEffectivenessRow[],
  scope: Phase7CRecommendationTargetScope,
  key: string,
): Phase7CPerformanceEffectivenessRow[] {
  if (scope === "RULE") {
    return rows.filter((row) => row.rules.passed.includes(key) || row.rules.blocked.includes(key));
  }
  if (scope === "ENTRY_TYPE") {
    return rows.filter((row) => row.entryType === key);
  }
  return rows.filter((row) => row.management.events.some((event) => event.family === key));
}

function contexts(rows: readonly Phase7CPerformanceEffectivenessRow[]) {
  return {
    strategies: [...new Set(rows.map((row) => row.strategy))].sort(),
    regimes: [...new Set(
      rows.map((row) => row.regime).filter((value): value is string => Boolean(value)),
    )].sort(),
  };
}

function scenarioComparableDelta(scenario: Phase7CCounterfactualScenario): number | null {
  if (finite(scenario.delta.lockedProfitPrice)) return scenario.delta.lockedProfitPrice;
  if (finite(scenario.delta.exitPrice)) return scenario.delta.exitPrice;
  return null;
}

function aggregateVerdict(
  scenarios: readonly Phase7CCounterfactualScenario[],
): Phase7CRecommendationP4Verdict {
  if (scenarios.length === 0) return "UNAVAILABLE";
  if (scenarios.every((scenario) => scenario.evidence.verdict === "EXACT")) return "EXACT";
  if (scenarios.some((scenario) => scenario.evidence.verdict !== "UNAVAILABLE")) return "BOUNDED";
  return "UNAVAILABLE";
}

function counterfactualEvidence(
  scenarios: readonly Phase7CCounterfactualScenario[],
): Phase7CRecommendationCounterfactualEvidence {
  const qualified = scenarios.filter((scenario) => scenario.evidence.verdict !== "UNAVAILABLE");
  const comparable = qualified
    .map(scenarioComparableDelta)
    .filter((value): value is number => value !== null);
  const netPnl = qualified.map((scenario) => scenario.delta.netPnl).filter(finite);
  const realizedR = qualified.map((scenario) => scenario.delta.realizedR).filter(finite);
  const hasPositive = comparable.some((value) => value > 0);
  const hasNegative = comparable.some((value) => value < 0);

  return {
    verdict: aggregateVerdict(scenarios),
    scenarioCount: scenarios.length,
    exactCount: scenarios.filter((scenario) => scenario.evidence.verdict === "EXACT").length,
    boundedCount: scenarios.filter((scenario) => scenario.evidence.verdict === "BOUNDED").length,
    unavailableCount: scenarios.filter((scenario) => scenario.evidence.verdict === "UNAVAILABLE").length,
    comparableDelta: average(comparable),
    counterfactualNetPnlDelta: average(netPnl),
    counterfactualRealizedRDelta: average(realizedR),
    conflict: hasPositive && hasNegative,
  };
}

function ruleScenarios(
  counterfactual: Phase7CCounterfactualSnapshot,
  key: string,
): Phase7CCounterfactualScenario[] {
  return counterfactual.scenarios.filter(
    (scenario) => scenario.family === "RULE_OBSERVATION" && scenario.baseline.ruleId === key,
  );
}

function managementScenarios(
  counterfactual: Phase7CCounterfactualSnapshot,
  key: string,
): Phase7CCounterfactualScenario[] {
  return counterfactual.scenarios.filter((scenario) => {
    if (
      scenario.family === "MANAGEMENT_EXIT_POLICY" &&
      scenario.baseline.managementFamily === key
    ) {
      return true;
    }
    return key.startsWith("FAST_MOVE") && scenario.family === "FAST_MOVE_GIVEBACK";
  });
}

function recommendationCandidate(
  scope: Phase7CRecommendationTargetScope,
  bucket: Phase7CPerformanceEffectivenessMetricBucket,
  effectiveness: Phase7CPerformanceEffectivenessSnapshot,
  scenarios: readonly Phase7CCounterfactualScenario[],
  unavailableReason?: Phase7CRecommendationReasonCode,
): Phase7CRecommendationCandidate {
  const rows = candidateRows(effectiveness.rows, scope, bucket.key);
  const exactRows = rows.filter(exactRow).length;
  const lineageExact = bucket.sampleSize > 0 && rows.length > 0 && exactRows === rows.length;
  const p4 = counterfactualEvidence(scenarios);
  const decision = evaluatePhase7CRecommendationCandidate({
    targetScope: scope,
    targetKey: bucket.key,
    sampleSize: bucket.sampleSize,
    lineageExact,
    p3Qualified: bucket.sampleSize > 0,
    p4Verdict: p4.verdict,
    comparableDelta: p4.comparableDelta,
    counterfactualNetPnlDelta: p4.counterfactualNetPnlDelta,
    counterfactualRealizedRDelta: p4.counterfactualRealizedRDelta,
    conflict: p4.conflict,
    unavailableReason,
  });

  const scenarioWarnings = scenarios.flatMap((scenario) => scenario.quality.warnings);
  return {
    schemaVersion: PHASE7C_RECOMMENDATION_INTELLIGENCE_SCHEMA_VERSION,
    recommendationId: `${scope}:${bucket.key}`,
    targetScope: scope,
    targetKey: bucket.key,
    contexts: contexts(rows),
    sampleSize: bucket.sampleSize,
    lineage: {
      exact: lineageExact,
      exactRows,
      totalRows: rows.length,
    },
    observed: observed(bucket),
    counterfactual: p4,
    evidenceScore: decision.evidenceScore,
    evidenceScoreIsNotProbability: true,
    action: decision.action,
    confidence: decision.confidence,
    reasonCodes: decision.reasonCodes,
    limitations: [...new Set([...decision.limitations, ...scenarioWarnings])],
    safety: phase7CRecommendationSafety(),
  };
}

function buildRuleCandidates(
  effectiveness: Phase7CPerformanceEffectivenessSnapshot,
  counterfactual: Phase7CCounterfactualSnapshot,
): Phase7CRecommendationCandidate[] {
  return effectiveness.aggregates.rule.map((bucket) =>
    recommendationCandidate(
      "RULE",
      bucket,
      effectiveness,
      ruleScenarios(counterfactual, bucket.key),
      "COUNTERFACTUAL_RULE_REPLAY_UNAVAILABLE",
    ),
  );
}

function buildEntryTypeCandidates(
  effectiveness: Phase7CPerformanceEffectivenessSnapshot,
): Phase7CRecommendationCandidate[] {
  return effectiveness.aggregates.entryType.map((bucket) =>
    recommendationCandidate(
      "ENTRY_TYPE",
      bucket,
      effectiveness,
      [],
      "COUNTERFACTUAL_ENTRY_REPLAY_UNAVAILABLE",
    ),
  );
}

function buildManagementCandidates(
  effectiveness: Phase7CPerformanceEffectivenessSnapshot,
  counterfactual: Phase7CCounterfactualSnapshot,
): Phase7CRecommendationCandidate[] {
  return effectiveness.aggregates.management.map((bucket) =>
    recommendationCandidate(
      "MANAGEMENT",
      bucket,
      effectiveness,
      managementScenarios(counterfactual, bucket.key),
    ),
  );
}

export function buildPhase7CRecommendationSnapshotFromEvidence(
  input: Phase7CRecommendationEvidenceInput,
): Phase7CRecommendationSnapshot {
  const recommendations = [
    ...buildRuleCandidates(input.effectiveness, input.counterfactual),
    ...buildEntryTypeCandidates(input.effectiveness),
    ...buildManagementCandidates(input.effectiveness, input.counterfactual),
  ].sort((left, right) => {
    const scopeOrder = { RULE: 0, ENTRY_TYPE: 1, MANAGEMENT: 2 } as const;
    const byScope = scopeOrder[left.targetScope] - scopeOrder[right.targetScope];
    return byScope !== 0 ? byScope : left.targetKey.localeCompare(right.targetKey);
  });

  return {
    schemaVersion: PHASE7C_RECOMMENDATION_INTELLIGENCE_SCHEMA_VERSION,
    generatedAt: Number.isFinite(Number(input.generatedAt))
      ? Number(input.generatedAt)
      : Math.max(input.effectiveness.generatedAt, input.counterfactual.generatedAt),
    source: "PHASE7C_RECOMMENDATION_INTELLIGENCE",
    readOnly: true,
    advisoryOnly: true,
    evidenceScoreIsNotProbability: true,
    safety: phase7CRecommendationSafety(),
    thresholds: {
      minSampleForReview: MIN_SAMPLE_FOR_REVIEW,
      minSampleForHighConfidence: MIN_SAMPLE_FOR_HIGH_CONFIDENCE,
    },
    summary: {
      candidateCount: recommendations.length,
      reviewChangeCount: recommendations.filter((item) => item.action === "REVIEW_CHANGE").length,
      keepCurrentCount: recommendations.filter((item) => item.action === "KEEP_CURRENT").length,
      collectMoreEvidenceCount: recommendations.filter((item) => item.action === "COLLECT_MORE_EVIDENCE").length,
      unavailableCount: recommendations.filter((item) => item.action === "UNAVAILABLE").length,
    },
    recommendations,
    notes: [
      "P5 is READ ONLY and ADVISORY ONLY. It never applies recommendations or retunes LIVE strategy/risk/runtime configuration.",
      "Evidence score is an audit completeness score, not a probability, confidence interval, expected return, or causal estimate.",
      "P3 observational differences alone never create RULE or ENTRY_TYPE change recommendations; canonical P4 evidence is required.",
      "BOUNDED counterfactual evidence can support human REVIEW_CHANGE only with explicit directional deltas, sufficient sample size, and no contradiction; confidence is capped at MEDIUM.",
      "P4 evidence is considered EXACT for a target only when every matched scenario is EXACT; mixed EXACT/BOUNDED/UNAVAILABLE evidence remains fail-closed as BOUNDED.",
      "Unproved counterfactual PnL and realized-R remain null and are never inferred from observed P3 outcomes.",
    ],
  };
}

export async function getPhase7CRecommendationIntelligence(
  query: Phase7CRecommendationQuery = {},
): Promise<Phase7CRecommendationSnapshot> {
  const effectiveness = await getPhase7CPerformanceEffectivenessSnapshot(query);
  const counterfactual = await buildPhase7CCounterfactualSnapshotFromRowsWithEvidence({
    rows: effectiveness.rows,
    generatedAt: effectiveness.generatedAt,
    evidenceProvider: runtimeFastMoveEvidenceProvider,
  });
  return buildPhase7CRecommendationSnapshotFromEvidence({
    effectiveness,
    counterfactual,
    generatedAt: effectiveness.generatedAt,
  });
}
