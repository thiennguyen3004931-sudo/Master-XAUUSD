export type Phase7CRecommendationTargetScope = "RULE" | "ENTRY_TYPE" | "MANAGEMENT";
export type Phase7CRecommendationAction =
  | "KEEP_CURRENT"
  | "REVIEW_CHANGE"
  | "COLLECT_MORE_EVIDENCE"
  | "UNAVAILABLE";
export type Phase7CRecommendationConfidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";
export type Phase7CRecommendationP4Verdict = "EXACT" | "BOUNDED" | "UNAVAILABLE";

export type Phase7CRecommendationReasonCode =
  | "EXACT_LINEAGE_REQUIRED"
  | "P3_EFFECTIVENESS_UNQUALIFIED"
  | "INSUFFICIENT_SAMPLE"
  | "COUNTERFACTUAL_UNAVAILABLE"
  | "COUNTERFACTUAL_RULE_REPLAY_UNAVAILABLE"
  | "COUNTERFACTUAL_ENTRY_REPLAY_UNAVAILABLE"
  | "BOUNDED_DIRECTIONAL_EVIDENCE"
  | "EXACT_IMPROVEMENT_EVIDENCE"
  | "NO_PROVEN_IMPROVEMENT"
  | "EVIDENCE_CONFLICT"
  | "MISSING_COMPARABLE_DELTA"
  | "PNL_NOT_PROVABLE"
  | "REALIZED_R_NOT_PROVABLE"
  | "HIGH_CONFIDENCE_SAMPLE_NOT_MET";

export interface Phase7CRecommendationSafety {
  readOnly: true;
  advisoryOnly: true;
  runtimeMutation: false;
  strategyMutation: false;
  riskMutation: false;
  orderMutation: false;
  positionMutation: false;
  modeMutation: false;
  armMutation: false;
  autoApply: false;
  autoRetune: false;
  liveTestOrder: false;
}

export interface Phase7CRecommendationCandidate {
  schemaVersion: "phase7c-recommendation-intelligence-v1";
  recommendationId: string;
  targetScope: Phase7CRecommendationTargetScope;
  targetKey: string;
  contexts: { strategies: string[]; regimes: string[] };
  sampleSize: number;
  lineage: { exact: boolean; exactRows: number; totalRows: number };
  observed: {
    sampleSize: number;
    wins: number;
    losses: number;
    breakeven: number;
    netPnl: number;
    expectancy: number;
    winRatePercent: number;
    profitFactor: number | null;
  };
  counterfactual: {
    verdict: Phase7CRecommendationP4Verdict;
    scenarioCount: number;
    exactCount: number;
    boundedCount: number;
    unavailableCount: number;
    comparableDelta: number | null;
    counterfactualNetPnlDelta: number | null;
    counterfactualRealizedRDelta: number | null;
    conflict: boolean;
  };
  evidenceScore: number;
  evidenceScoreIsNotProbability: true;
  action: Phase7CRecommendationAction;
  confidence: Phase7CRecommendationConfidence;
  reasonCodes: Phase7CRecommendationReasonCode[];
  limitations: string[];
  safety: Phase7CRecommendationSafety;
}

export interface Phase7CRecommendationSnapshot {
  schemaVersion: "phase7c-recommendation-intelligence-v1";
  generatedAt: number;
  source: "PHASE7C_RECOMMENDATION_INTELLIGENCE";
  readOnly: true;
  advisoryOnly: true;
  evidenceScoreIsNotProbability: true;
  safety: Phase7CRecommendationSafety;
  thresholds: {
    minSampleForReview: 10;
    minSampleForHighConfidence: 30;
  };
  summary: {
    candidateCount: number;
    reviewChangeCount: number;
    keepCurrentCount: number;
    collectMoreEvidenceCount: number;
    unavailableCount: number;
  };
  recommendations: Phase7CRecommendationCandidate[];
  notes: string[];
}
