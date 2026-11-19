import { SignalType, TradingSession } from "@xauusd/types";
import type { StrategyEngineConfig } from "../config";
import type {
  MarketRegimeAssessment,
  StrategyCandidate,
  StrategyContext,
} from "../models";
import { SignalDirectionUtils } from "../utils";
import { BaseStrategy } from "./BaseStrategy";

export class LiquiditySweepReversalStrategy extends BaseStrategy {
  readonly id = "LIQUIDITY_SWEEP_REVERSAL" as const;
  readonly name = "Liquidity Sweep Reversal";
  readonly supportedRegimes = ["REVERSAL", "RANGING"] as const;
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
    const latestChoch = [...context.analysis.structureEvents]
      .filter((event) => event.confirmed && event.type === "CHOCH")
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    const chochAligned = signal && latestChoch
      ? SignalDirectionUtils.matchesTrend(direction, latestChoch.direction)
      : false;
    const hasLiquidity = context.analysis.liquidityZones.length > 0;
    const hasConfluenceZone =
      context.analysis.orderBlocks.length > 0 ||
      context.analysis.fairValueGaps.length > 0;
    const rsi = context.indicators.latest.rsi;
    const stochastic = context.indicators.latest.stochastic;
    const oscillatorExtreme = signal
      ? direction === SignalType.BUY
        ? (rsi ?? 50) <= config.reversalRsiOversold || (stochastic.k ?? 50) <= 20
        : (rsi ?? 50) >= config.reversalRsiOverbought || (stochastic.k ?? 50) >= 80
      : false;
    const regimeSupported = this.supportedRegimes.includes(regime.regime as never);
    const sessionSupported = this.supportedSessions.includes(session as never);
    const mtfOpposing = signal && context.multiTimeframe
      ? !SignalDirectionUtils.matchesTrend(direction, context.multiTimeframe.bias)
      : false;

    const eligible = Boolean(
      signal && latestChoch && chochAligned && hasLiquidity && regimeSupported && sessionSupported,
    );

    return this.candidate(
      direction,
      {
        signal: signal ? Math.min(18, signal.confidence * 0.18) : 0,
        structure: latestChoch && chochAligned ? 30 : latestChoch ? 8 : 0,
        regime: regimeSupported ? Math.min(15, regime.confidence * 0.15) : 0,
        momentum: oscillatorExtreme ? 12 : 4,
        location: hasLiquidity && hasConfluenceZone ? 15 : hasLiquidity ? 8 : 0,
        multiTimeframe: mtfOpposing ? 0 : context.multiTimeframe ? 8 : 4,
        session: sessionSupported ? 5 : 0,
      },
      eligible,
      [
        latestChoch ? "A confirmed CHOCH is available." : "No confirmed CHOCH is available.",
        hasLiquidity ? "Liquidity reference zones are present." : "No liquidity reference zone is present.",
        oscillatorExtreme ? "Oscillators support reversal exhaustion." : "Oscillators are not at an exhaustion extreme.",
      ],
      ["Price trades beyond the sweep extreme and approved stop-loss.", "CHOCH confirmation is invalidated by a new structure break."],
      mtfOpposing ? ["The reversal trades against the multi-timeframe bias."] : [],
      config,
    );
  }
}
