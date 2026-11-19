import { SignalType, TradingSession } from "@xauusd/types";
import type { StrategyEngineConfig } from "../config";
import type {
  MarketRegimeAssessment,
  StrategyCandidate,
  StrategyContext,
} from "../models";
import { PriceLocationUtils, SignalDirectionUtils } from "../utils";
import { BaseStrategy } from "./BaseStrategy";

export class TrendContinuationStrategy extends BaseStrategy {
  readonly id = "TREND_CONTINUATION" as const;
  readonly name = "Trend Continuation";
  readonly supportedRegimes = ["TRENDING", "BREAKOUT"] as const;
  readonly supportedSessions = [
    TradingSession.ASIAN,
    TradingSession.LONDON,
    TradingSession.NEW_YORK,
    TradingSession.OVERLAP,
  ] as const;

  evaluate(
    context: StrategyContext,
    regime: MarketRegimeAssessment,
    session: TradingSession,
    config: StrategyEngineConfig,
  ): StrategyCandidate {
    const signal = context.signalResult.signal;
    const direction = signal?.type ?? SignalType.NONE;
    const trendAligned = signal
      ? SignalDirectionUtils.matchesTrend(direction, context.analysis.trend)
      : false;
    const structureAligned = signal
      ? SignalDirectionUtils.matchesStructure(direction, context.analysis.structure)
      : false;
    const adx = context.indicators.latest.adx.adx;
    const macdHistogram = context.indicators.latest.macd.histogram;
    const momentumAligned = signal
      ? direction === SignalType.BUY
        ? (macdHistogram ?? 0) > 0
        : (macdHistogram ?? 0) < 0
      : false;
    const mtfAligned = signal && context.multiTimeframe
      ? SignalDirectionUtils.matchesTrend(direction, context.multiTimeframe.bias)
      : false;
    const favorableLocation = signal
      ? PriceLocationUtils.isFavorable(direction, context.indicators.latest.close, context.analysis)
      : false;
    const sessionSupported = this.supportedSessions.includes(session as never);
    const regimeSupported = this.supportedRegimes.includes(regime.regime as never);

    const eligible = Boolean(
      signal &&
      SignalDirectionUtils.isDirectional(direction) &&
      trendAligned &&
      structureAligned &&
      regimeSupported &&
      sessionSupported,
    );

    const reasons = [
      trendAligned ? "Signal aligns with the detected trend." : "Signal is not aligned with the detected trend.",
      structureAligned ? "Market structure confirms the direction." : "Market structure does not confirm the direction.",
      adx !== null && adx >= config.trendAdxThreshold
        ? "ADX supports trend continuation."
        : "ADX does not strongly support continuation.",
      momentumAligned ? "MACD histogram confirms momentum." : "MACD momentum is not aligned.",
    ];

    return this.candidate(
      direction,
      {
        signal: signal ? Math.min(20, signal.confidence * 0.2) : 0,
        structure: trendAligned && structureAligned ? 25 : trendAligned ? 12 : 0,
        regime: regimeSupported ? Math.min(15, regime.confidence * 0.15) : 0,
        momentum: momentumAligned ? 15 : adx !== null && adx >= config.trendAdxThreshold ? 8 : 0,
        location: favorableLocation ? 10 : 4,
        multiTimeframe: mtfAligned ? 10 : context.multiTimeframe ? 0 : 5,
        session: sessionSupported ? 5 : 0,
      },
      eligible,
      reasons,
      ["Trend or structure flips against the approved order direction.", "Price closes beyond the approved stop-loss level."],
      favorableLocation ? [] : ["Entry is not in the preferred discount/premium location."],
      config,
    );
  }
}
