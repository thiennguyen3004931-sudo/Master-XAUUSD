import type { StrategyEvaluation } from "@xauusd/strategy-engine";
import type { IHistoricalStrategyEvaluator } from "../contracts";
import type { HistoricalStrategyContext } from "../models";

export class PrecomputedStrategyEvaluator
  implements IHistoricalStrategyEvaluator
{
  private readonly evaluations = new Map<
    number,
    StrategyEvaluation
  >();

  constructor(
    entries: readonly [
      candleOpenTime: number,
      evaluation: StrategyEvaluation,
    ][],
    private readonly fallback: StrategyEvaluation,
  ) {
    for (const [openTime, evaluation] of entries) {
      this.evaluations.set(openTime, evaluation);
    }
  }

  evaluate(
    context: HistoricalStrategyContext,
  ): StrategyEvaluation {
    return (
      this.evaluations.get(context.currentCandle.openTime) ??
      this.fallback
    );
  }
}
