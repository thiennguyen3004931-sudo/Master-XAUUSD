import type { StrategyContext, StrategyEvaluation } from "../models";

export interface IStrategyEngine {
  evaluate(context: StrategyContext): StrategyEvaluation;
}
