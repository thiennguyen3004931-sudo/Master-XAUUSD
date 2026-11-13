import type { SignalType, TradingSession } from "@xauusd/types";
import type { StrategyEngineConfig } from "../config";
import type {
  MarketRegime,
  MarketRegimeAssessment,
  StrategyCandidate,
  StrategyContext,
  StrategyId,
  StrategyScoreBreakdown,
} from "../models";
import { NumberUtils } from "../utils";
import type { IStrategyModule } from "../contracts";

export abstract class BaseStrategy implements IStrategyModule {
  abstract readonly id: StrategyId;
  abstract readonly name: string;
  abstract readonly supportedRegimes: readonly MarketRegime[];
  abstract readonly supportedSessions: readonly TradingSession[];

  abstract evaluate(
    context: StrategyContext,
    regime: MarketRegimeAssessment,
    session: TradingSession,
    config: StrategyEngineConfig,
  ): StrategyCandidate;

  protected candidate(
    direction: SignalType,
    breakdown: Omit<StrategyScoreBreakdown, "total">,
    eligible: boolean,
    reasons: string[],
    invalidations: string[],
    warnings: string[],
    config: StrategyEngineConfig,
  ): StrategyCandidate {
    const rawScore = Object.values(breakdown).reduce(
      (sum, value) => sum + value,
      0,
    );
    const score = NumberUtils.clamp(
      rawScore * config.strategyWeights[this.id],
      0,
      100,
    );

    return {
      strategyId: this.id,
      name: this.name,
      eligible,
      direction,
      score: NumberUtils.round(score),
      rawScore: NumberUtils.round(rawScore),
      scoreBreakdown: {
        ...breakdown,
        total: NumberUtils.round(score),
      },
      supportedRegimes: this.supportedRegimes,
      supportedSessions: this.supportedSessions,
      reasons,
      invalidations,
      warnings,
    };
  }
}
