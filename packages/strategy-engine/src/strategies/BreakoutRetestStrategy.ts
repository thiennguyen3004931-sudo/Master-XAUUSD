import { SignalType, TradingSession } from "@xauusd/types";
import type { StrategyEngineConfig } from "../config";
import type {
  MarketRegimeAssessment,
  StrategyCandidate,
  StrategyContext,
} from "../models";
import { SignalDirectionUtils } from "../utils";
import { BaseStrategy } from "./BaseStrategy";

export class BreakoutRetestStrategy extends BaseStrategy {
  readonly id = "BREAKOUT_RETEST" as const;
  readonly name = "Breakout Retest";
  readonly supportedRegimes = ["BREAKOUT", "TRENDING"] as const;
  readonly supportedSessions = [
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
    const confirmedBos = [...context.analysis.structureEvents]
      .filter((event) => event.confirmed && event.type === "BOS")
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    const bosAligned = signal && confirmedBos
      ? SignalDirectionUtils.matchesTrend(direction, confirmedBos.direction)
      : false;
    const adx = context.indicators.latest.adx.adx;
    const volumeSma = context.indicators.latest.volumeSma;
    const latestVolume = context.analysis.lastCandle?.volume ?? 0;
    const volumeConfirmed = volumeSma !== null && latestVolume > volumeSma;
    const regimeSupported = this.supportedRegimes.includes(regime.regime as never);
    const sessionSupported = this.supportedSessions.includes(session as never);
    const mtfAligned = signal && context.multiTimeframe
      ? SignalDirectionUtils.matchesTrend(direction, context.multiTimeframe.bias)
      : false;

    const eligible = Boolean(
      signal && confirmedBos && bosAligned && regimeSupported && sessionSupported,
    );

    return this.candidate(
      direction,
      {
        signal: signal ? Math.min(20, signal.confidence * 0.2) : 0,
        structure: confirmedBos && bosAligned ? 30 : confirmedBos ? 8 : 0,
        regime: regimeSupported ? Math.min(15, regime.confidence * 0.15) : 0,
        momentum: adx !== null && adx >= config.breakoutAdxThreshold ? 12 : 4,
        location: volumeConfirmed ? 8 : 3,
        multiTimeframe: mtfAligned ? 10 : context.multiTimeframe ? 0 : 5,
        session: sessionSupported ? 5 : 0,
      },
      eligible,
      [
        confirmedBos ? "A confirmed BOS is available." : "No confirmed BOS is available.",
        bosAligned ? "BOS direction agrees with the signal." : "BOS direction conflicts with the signal.",
        volumeConfirmed ? "Volume exceeds its moving average." : "Volume expansion is not confirmed.",
      ],
      ["Price re-enters and closes inside the pre-breakout range.", "The confirmed BOS level fails before entry."],
      volumeConfirmed ? [] : ["Breakout volume is below its moving average."],
      config,
    );
  }
}
