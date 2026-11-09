import { SignalType } from "@xauusd/types";
import type { Signal } from "@xauusd/types";
import type { SignalEngineConfig } from "../config";
import type {
  SignalContext,
  SignalDirection,
  SignalLevelPlan,
  SignalRuleResult,
  SignalScore,
} from "../models";
import { SignalStrengthService } from "./SignalStrengthService";

export class SignalFactory {
  constructor(private readonly strengthService = new SignalStrengthService()) {}

  create(
    context: SignalContext,
    direction: Exclude<SignalDirection, "NEUTRAL">,
    score: SignalScore,
    levels: SignalLevelPlan,
    results: readonly SignalRuleResult[],
    config: SignalEngineConfig,
    generatedAt: number,
  ): Signal {
    const reasons = results
      .filter((result) => result.direction === direction)
      .sort((left, right) => {
        const leftPoints = direction === "BULLISH" ? left.bullishPoints : left.bearishPoints;
        const rightPoints = direction === "BULLISH" ? right.bullishPoints : right.bearishPoints;
        return rightPoints - leftPoints;
      })
      .slice(0, config.maximumReasons)
      .map((result) => result.reason);

    return {
      symbol: context.analysis.symbol,
      timeframe: String(context.analysis.timeframe),
      type: direction === "BULLISH" ? SignalType.BUY : SignalType.SELL,
      strength: this.strengthService.fromConfidence(score.confidence),
      confidence: score.confidence,
      entry: levels.entry,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
      reasons,
      createdAt: generatedAt,
    };
  }
}
