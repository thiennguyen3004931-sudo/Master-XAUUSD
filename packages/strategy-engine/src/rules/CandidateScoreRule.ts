import type { StrategyEngineConfig } from "../config";
import type { IStrategyRule } from "../contracts";
import type { StrategyContext, StrategyEvaluationDraft, StrategyRuleResult } from "../models";

export class CandidateScoreRule implements IStrategyRule {
  readonly name = "candidate-score";
  evaluate(_context: StrategyContext, draft: StrategyEvaluationDraft, config: StrategyEngineConfig): StrategyRuleResult {
    const score = draft.selection.selected?.score ?? 0;
    const passed = draft.selection.selected !== null && score >= config.minimumCandidateScore;
    return {
      rule: this.name,
      passed,
      actionOnFailure: "WAIT",
      code: passed ? undefined : "STRATEGY_SCORE_TOO_LOW",
      message: passed ? "Selected strategy score meets the configured minimum." : "Selected strategy score is below the configured minimum.",
      metrics: { score, minimum: config.minimumCandidateScore },
    };
  }
}
