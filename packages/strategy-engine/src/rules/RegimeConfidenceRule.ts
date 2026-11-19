import type { StrategyEngineConfig } from "../config";
import type { IStrategyRule } from "../contracts";
import type { StrategyContext, StrategyEvaluationDraft, StrategyRuleResult } from "../models";

export class RegimeConfidenceRule implements IStrategyRule {
  readonly name = "regime-confidence";
  evaluate(_context: StrategyContext, draft: StrategyEvaluationDraft, config: StrategyEngineConfig): StrategyRuleResult {
    const passed = draft.regime.confidence >= config.minimumRegimeConfidence;
    return {
      rule: this.name,
      passed,
      actionOnFailure: "WAIT",
      code: passed ? undefined : "REGIME_CONFIDENCE_LOW",
      message: passed ? "Market regime confidence is sufficient." : "Market regime confidence is below the required threshold.",
      metrics: { confidence: draft.regime.confidence, minimum: config.minimumRegimeConfidence },
    };
  }
}
