import assert from "node:assert/strict";
import {
  evaluatePhase7CRecommendationCandidate,
  MIN_SAMPLE_FOR_HIGH_CONFIDENCE,
  MIN_SAMPLE_FOR_REVIEW,
} from "../apps/api/src/services/phase7c-recommendation-evaluator.service";

const base = {
  targetScope: "MANAGEMENT" as const,
  targetKey: "FAST_MOVE_TIGHTEN",
  sampleSize: 12,
  lineageExact: true,
  p3Qualified: true,
  p4Verdict: "BOUNDED" as const,
  comparableDelta: 2,
  counterfactualNetPnlDelta: null,
  counterfactualRealizedRDelta: null,
  conflict: false,
};

assert.equal(MIN_SAMPLE_FOR_REVIEW, 10);
assert.equal(MIN_SAMPLE_FOR_HIGH_CONFIDENCE, 30);

const boundedReview = evaluatePhase7CRecommendationCandidate(base);
assert.equal(boundedReview.action, "REVIEW_CHANGE");
assert.equal(boundedReview.confidence, "MEDIUM");
assert.equal(boundedReview.counterfactualNetPnlDelta, null);
assert.equal(boundedReview.counterfactualRealizedRDelta, null);
assert.ok(boundedReview.reasonCodes.includes("BOUNDED_DIRECTIONAL_EVIDENCE"));
assert.ok(boundedReview.reasonCodes.includes("PNL_NOT_PROVABLE"));
assert.ok(boundedReview.reasonCodes.includes("REALIZED_R_NOT_PROVABLE"));
assert.equal(boundedReview.evidenceScoreIsNotProbability, true);
assert.ok(boundedReview.evidenceScore >= 0 && boundedReview.evidenceScore <= 100);

const boundedLarge = evaluatePhase7CRecommendationCandidate({ ...base, sampleSize: 100 });
assert.equal(boundedLarge.action, "REVIEW_CHANGE");
assert.notEqual(boundedLarge.confidence, "HIGH");

const tooSmall = evaluatePhase7CRecommendationCandidate({ ...base, sampleSize: 9 });
assert.equal(tooSmall.action, "COLLECT_MORE_EVIDENCE");
assert.ok(tooSmall.reasonCodes.includes("INSUFFICIENT_SAMPLE"));

const unavailable = evaluatePhase7CRecommendationCandidate({
  ...base,
  p4Verdict: "UNAVAILABLE" as const,
  comparableDelta: null,
});
assert.notEqual(unavailable.action, "REVIEW_CHANGE");
assert.ok(unavailable.reasonCodes.includes("COUNTERFACTUAL_UNAVAILABLE"));

const ruleUnavailable = evaluatePhase7CRecommendationCandidate({
  ...base,
  targetScope: "RULE" as const,
  targetKey: "RULE_A",
  p4Verdict: "UNAVAILABLE" as const,
  comparableDelta: null,
  unavailableReason: "COUNTERFACTUAL_RULE_REPLAY_UNAVAILABLE" as const,
});
assert.equal(ruleUnavailable.action, "COLLECT_MORE_EVIDENCE");
assert.ok(ruleUnavailable.reasonCodes.includes("COUNTERFACTUAL_RULE_REPLAY_UNAVAILABLE"));

const conflicted = evaluatePhase7CRecommendationCandidate({ ...base, conflict: true });
assert.notEqual(conflicted.action, "REVIEW_CHANGE");
assert.ok(conflicted.reasonCodes.includes("EVIDENCE_CONFLICT"));

const noLineage = evaluatePhase7CRecommendationCandidate({ ...base, lineageExact: false });
assert.equal(noLineage.action, "UNAVAILABLE");
assert.equal(noLineage.confidence, "NONE");
assert.ok(noLineage.reasonCodes.includes("EXACT_LINEAGE_REQUIRED"));

const missingDelta = evaluatePhase7CRecommendationCandidate({ ...base, comparableDelta: null });
assert.equal(missingDelta.action, "COLLECT_MORE_EVIDENCE");
assert.ok(missingDelta.reasonCodes.includes("MISSING_COMPARABLE_DELTA"));

const boundedKeep = evaluatePhase7CRecommendationCandidate({ ...base, comparableDelta: 0 });
assert.equal(boundedKeep.action, "KEEP_CURRENT");
assert.equal(boundedKeep.confidence, "MEDIUM");
assert.ok(boundedKeep.reasonCodes.includes("NO_PROVEN_IMPROVEMENT"));

const exactMedium = evaluatePhase7CRecommendationCandidate({
  ...base,
  p4Verdict: "EXACT" as const,
  sampleSize: 12,
  comparableDelta: 1.5,
  counterfactualNetPnlDelta: 5,
  counterfactualRealizedRDelta: 0.2,
});
assert.equal(exactMedium.action, "REVIEW_CHANGE");
assert.equal(exactMedium.confidence, "MEDIUM");
assert.ok(exactMedium.reasonCodes.includes("EXACT_IMPROVEMENT_EVIDENCE"));
assert.ok(exactMedium.reasonCodes.includes("HIGH_CONFIDENCE_SAMPLE_NOT_MET"));

const exactHigh = evaluatePhase7CRecommendationCandidate({
  ...base,
  p4Verdict: "EXACT" as const,
  sampleSize: 30,
  comparableDelta: 1.5,
  counterfactualNetPnlDelta: 5,
  counterfactualRealizedRDelta: 0.2,
});
assert.equal(exactHigh.action, "REVIEW_CHANGE");
assert.equal(exactHigh.confidence, "HIGH");

const exactKeepHigh = evaluatePhase7CRecommendationCandidate({
  ...base,
  p4Verdict: "EXACT" as const,
  sampleSize: 30,
  comparableDelta: -0.5,
  counterfactualNetPnlDelta: null,
  counterfactualRealizedRDelta: null,
});
assert.equal(exactKeepHigh.action, "KEEP_CURRENT");
assert.equal(exactKeepHigh.confidence, "HIGH");

console.log("PHASE7C_RECOMMENDATION_EVALUATOR_SEMANTICS=PASS");
