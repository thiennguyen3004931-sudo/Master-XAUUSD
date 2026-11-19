import {
  type Phase7CRecommendationConfidence,
  type Phase7CRecommendationDecision,
  type Phase7CRecommendationP4Verdict,
  type Phase7CRecommendationReasonCode,
  type Phase7CRecommendationTargetScope,
} from "../contracts/phase7c-recommendation-intelligence.schema";

export const MIN_SAMPLE_FOR_REVIEW = 10 as const;
export const MIN_SAMPLE_FOR_HIGH_CONFIDENCE = 30 as const;

export interface Phase7CRecommendationEvaluationInput {
  targetScope: Phase7CRecommendationTargetScope;
  targetKey: string;
  sampleSize: number;
  lineageExact: boolean;
  p3Qualified: boolean;
  p4Verdict: Phase7CRecommendationP4Verdict;
  comparableDelta: number | null;
  counterfactualNetPnlDelta: number | null;
  counterfactualRealizedRDelta: number | null;
  conflict: boolean;
  unavailableReason?: Phase7CRecommendationReasonCode;
}

function finiteOrNull(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function evidenceScore(input: Phase7CRecommendationEvaluationInput): number {
  let score = 0;
  if (input.lineageExact) score += 25;
  if (input.p3Qualified) {
    score += input.sampleSize >= MIN_SAMPLE_FOR_REVIEW ? 20 : 10;
  }
  if (input.p4Verdict === "EXACT") score += 30;
  if (input.p4Verdict === "BOUNDED") score += 20;
  if (finiteOrNull(input.comparableDelta) !== null) score += 15;
  if (!input.conflict) score += 10;
  return Math.max(0, Math.min(100, score));
}

function proofLimitations(
  input: Phase7CRecommendationEvaluationInput,
): { reasonCodes: Phase7CRecommendationReasonCode[]; limitations: string[] } {
  const reasonCodes: Phase7CRecommendationReasonCode[] = [];
  const limitations: string[] = [];
  if (finiteOrNull(input.counterfactualNetPnlDelta) === null) {
    reasonCodes.push("PNL_NOT_PROVABLE");
    limitations.push("Counterfactual PnL is not explicitly proved and remains null.");
  }
  if (finiteOrNull(input.counterfactualRealizedRDelta) === null) {
    reasonCodes.push("REALIZED_R_NOT_PROVABLE");
    limitations.push("Counterfactual realized-R is not explicitly proved and remains null.");
  }
  return { reasonCodes, limitations };
}

function decision(
  input: Phase7CRecommendationEvaluationInput,
  action: Phase7CRecommendationDecision["action"],
  confidence: Phase7CRecommendationConfidence,
  primaryReasons: readonly Phase7CRecommendationReasonCode[],
  primaryLimitations: readonly string[] = [],
): Phase7CRecommendationDecision {
  const proof = proofLimitations(input);
  return {
    action,
    confidence,
    evidenceScore: evidenceScore(input),
    evidenceScoreIsNotProbability: true,
    reasonCodes: [...new Set([...primaryReasons, ...proof.reasonCodes])],
    limitations: [...new Set([...primaryLimitations, ...proof.limitations])],
    comparableDelta: finiteOrNull(input.comparableDelta),
    counterfactualNetPnlDelta: finiteOrNull(input.counterfactualNetPnlDelta),
    counterfactualRealizedRDelta: finiteOrNull(input.counterfactualRealizedRDelta),
  };
}

export function evaluatePhase7CRecommendationCandidate(
  input: Phase7CRecommendationEvaluationInput,
): Phase7CRecommendationDecision {
  if (!input.lineageExact) {
    return decision(
      input,
      "UNAVAILABLE",
      "NONE",
      ["EXACT_LINEAGE_REQUIRED"],
      ["Exact explicit Decision → Trade → Outcome lineage is required."],
    );
  }

  if (input.conflict) {
    return decision(
      input,
      "UNAVAILABLE",
      "NONE",
      ["EVIDENCE_CONFLICT"],
      ["Qualified counterfactual evidence contains both positive and negative directional deltas."],
    );
  }

  if (!input.p3Qualified) {
    return decision(
      input,
      "COLLECT_MORE_EVIDENCE",
      "NONE",
      ["P3_EFFECTIVENESS_UNQUALIFIED"],
      ["Observed P3 effectiveness evidence is not qualified for recommendation review."],
    );
  }

  if (input.p4Verdict === "UNAVAILABLE") {
    const reason = input.unavailableReason ?? "COUNTERFACTUAL_UNAVAILABLE";
    return decision(
      input,
      "COLLECT_MORE_EVIDENCE",
      input.sampleSize > 0 ? "LOW" : "NONE",
      [reason],
      ["Canonical counterfactual evidence is unavailable; no causal change claim is made."],
    );
  }

  if (input.sampleSize < MIN_SAMPLE_FOR_REVIEW) {
    return decision(
      input,
      "COLLECT_MORE_EVIDENCE",
      "LOW",
      ["INSUFFICIENT_SAMPLE"],
      [`At least ${MIN_SAMPLE_FOR_REVIEW} qualified samples are required for review.`],
    );
  }

  const comparableDelta = finiteOrNull(input.comparableDelta);
  if (comparableDelta === null) {
    return decision(
      input,
      "COLLECT_MORE_EVIDENCE",
      "LOW",
      ["MISSING_COMPARABLE_DELTA"],
      ["No explicit comparable counterfactual delta is available."],
    );
  }

  if (comparableDelta <= 0) {
    const confidence: Phase7CRecommendationConfidence =
      input.p4Verdict === "EXACT" && input.sampleSize >= MIN_SAMPLE_FOR_HIGH_CONFIDENCE
        ? "HIGH"
        : "MEDIUM";
    const reasons: Phase7CRecommendationReasonCode[] = ["NO_PROVEN_IMPROVEMENT"];
    if (input.p4Verdict === "EXACT" && input.sampleSize < MIN_SAMPLE_FOR_HIGH_CONFIDENCE) {
      reasons.push("HIGH_CONFIDENCE_SAMPLE_NOT_MET");
    }
    return decision(
      input,
      "KEEP_CURRENT",
      confidence,
      reasons,
      ["The evaluated alternative does not prove improvement over current behavior."],
    );
  }

  if (input.p4Verdict === "BOUNDED") {
    return decision(
      input,
      "REVIEW_CHANGE",
      "MEDIUM",
      ["BOUNDED_DIRECTIONAL_EVIDENCE"],
      ["BOUNDED evidence supports human review only; confidence is capped at MEDIUM."],
    );
  }

  const high = input.sampleSize >= MIN_SAMPLE_FOR_HIGH_CONFIDENCE;
  return decision(
    input,
    "REVIEW_CHANGE",
    high ? "HIGH" : "MEDIUM",
    high
      ? ["EXACT_IMPROVEMENT_EVIDENCE"]
      : ["EXACT_IMPROVEMENT_EVIDENCE", "HIGH_CONFIDENCE_SAMPLE_NOT_MET"],
    high
      ? []
      : [`HIGH confidence requires at least ${MIN_SAMPLE_FOR_HIGH_CONFIDENCE} qualified samples.`],
  );
}
