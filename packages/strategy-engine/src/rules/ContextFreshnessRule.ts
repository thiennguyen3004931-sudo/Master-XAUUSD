import type { StrategyEngineConfig } from "../config";
import type { IStrategyRule } from "../contracts";
import type { StrategyContext, StrategyEvaluationDraft, StrategyRuleResult } from "../models";

export class ContextFreshnessRule implements IStrategyRule {
  readonly name = "context-freshness";
  evaluate(context: StrategyContext, _draft: StrategyEvaluationDraft, config: StrategyEngineConfig): StrategyRuleResult {
    const evaluatedAt = context.evaluatedAt ?? Date.now();
    const sourceTimes = [
      context.analysis.createdAt,
      context.indicators.generatedAt,
      context.signalResult.generatedAt,
      context.riskAssessment.generatedAt,
    ];
    const oldest = Math.min(...sourceTimes);
    const ageMs = Math.max(0, evaluatedAt - oldest);
    const passed = ageMs <= config.maximumContextAgeMs;
    return {
      rule: this.name,
      passed,
      actionOnFailure: "WAIT",
      code: passed ? undefined : "CONTEXT_STALE",
      message: passed ? "All upstream decisions are fresh enough for strategy selection." : "One or more upstream decisions are stale.",
      metrics: { ageMs, maximumContextAgeMs: config.maximumContextAgeMs },
    };
  }
}
