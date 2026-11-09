import type { StrategyEngineConfig } from "../config";
import type {
  StrategyContext,
  StrategyEvaluationDraft,
  StrategyRuleResult,
} from "../models";

export interface IStrategyRule {
  readonly name: string;
  evaluate(
    context: StrategyContext,
    draft: StrategyEvaluationDraft,
    config: StrategyEngineConfig,
  ): StrategyRuleResult;
}
