import type { StrategyEngineConfig } from "../config";
import type { IStrategyRule } from "../contracts";
import type { StrategyContext, StrategyEvaluationDraft, StrategyRuleResult } from "../models";

export class SelectionEdgeRule implements IStrategyRule {
  readonly name = "selection-edge";
  evaluate(_context: StrategyContext, draft: StrategyEvaluationDraft, config: StrategyEngineConfig): StrategyRuleResult {
    const hasRunnerUp = draft.selection.runnerUp !== null;
    const passed = draft.selection.selected !== null && (!hasRunnerUp || draft.selection.edge >= config.minimumCandidateEdge);
    return {
      rule: this.name,
      passed,
      actionOnFailure: "WAIT",
      code: passed ? undefined : "STRATEGY_EDGE_TOO_LOW",
      message: passed ? "Selected strategy has sufficient separation from the runner-up." : "Top strategy candidates are too close to select safely.",
      metrics: { edge: draft.selection.edge, minimum: config.minimumCandidateEdge },
    };
  }
}
