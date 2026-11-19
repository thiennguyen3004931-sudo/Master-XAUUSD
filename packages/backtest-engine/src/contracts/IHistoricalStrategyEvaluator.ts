import type { StrategyEvaluation } from "@xauusd/strategy-engine";
import type { HistoricalStrategyContext } from "../models";

export interface IHistoricalStrategyEvaluator {
  evaluate(
    context: HistoricalStrategyContext,
  ): StrategyEvaluation | Promise<StrategyEvaluation>;
}
