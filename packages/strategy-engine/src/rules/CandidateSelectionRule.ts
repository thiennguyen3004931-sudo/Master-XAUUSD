import type { StrategyEngineConfig } from "../config";
import type { IStrategyRule } from "../contracts";
import type { StrategyContext, StrategyEvaluationDraft, StrategyRuleResult } from "../models";

export class CandidateSelectionRule implements IStrategyRule {
  readonly name = "candidate-selection";
  evaluate(_context: StrategyContext, draft: StrategyEvaluationDraft, _config: StrategyEngineConfig): StrategyRuleResult {
    const passed = draft.selection.selected !== null;
    return {
      rule: this.name,
      passed,
      actionOnFailure: "WAIT",
      code: passed ? undefined : "NO_ELIGIBLE_STRATEGY",
      message: passed ? "At least one eligible strategy candidate was found." : "No strategy matched the current context.",
    };
  }
}
