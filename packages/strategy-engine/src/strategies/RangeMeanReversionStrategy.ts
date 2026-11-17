import { SignalType, TradingSession } from "@xauusd/types";
import type { StrategyEngineConfig } from "../config";
import type {
  MarketRegimeAssessment,
  StrategyCandidate,
  StrategyContext,
} from "../models";
import { RangeBoundaryUtils } from "../utils";
import { BaseStrategy } from "./BaseStrategy";

export class RangeMeanReversionStrategy extends BaseStrategy {
  readonly id = "RANGE_MEAN_REVERSION" as const;
  readonly name = "Range Mean Reversion";
  readonly supportedRegimes = ["RANGING"] as const;
  readonly supportedSessions = [
    TradingSession.ASIAN,
    TradingSession.LONDON,
    TradingSession.NEW_YORK,
  ] as const;

  evaluate(
    context: StrategyContext,
    regime: MarketRegimeAssessment,
    session: TradingSession,
    config: StrategyEngineConfig,
  ): StrategyCandidate {
    const signal = context.signalResult.signal;
    const direction = signal?.type ?? SignalType.NONE;
    const close = context.indicators.latest.close;
    const adx = context.indicators.latest.adx.adx;
    const weakTrend = adx !== null && adx <= config.rangeAdxThreshold;
    const range = RangeBoundaryUtils.find(
      close,
      context.analysis.supplyDemandZones,
    );
    const nearDemand = range
      ? RangeBoundaryUtils.isNearDemand(range, close)
      : false;
    const nearSupply = range
      ? RangeBoundaryUtils.isNearSupply(range, close)
      : false;
    const boundaryAligned = signal
      ? direction === SignalType.BUY
        ? nearDemand
        : direction === SignalType.SELL
          ? nearSupply
          : false
      : false;
    const percentB = context.indicators.latest.bollingerBands.percentB;
    const bandExtreme = signal
      ? direction === SignalType.BUY
        ? (percentB ?? 0.5) <= 0.3
        : (percentB ?? 0.5) >= 0.7
      : false;
    const sessionSupported = this.supportedSessions.includes(session as never);
    const asianAllowed = session !== TradingSession.ASIAN || config.allowAsianRangeMeanReversion;
    const regimeSupported = this.supportedRegimes.includes(regime.regime as never);
    const supplyDemandConfirmed = Boolean(range);

    const eligible = Boolean(
      signal &&
      supplyDemandConfirmed &&
      weakTrend &&
      boundaryAligned &&
      regimeSupported &&
      sessionSupported &&
      asianAllowed,
    );

    return this.candidate(
      direction,
      {
        signal: signal ? Math.min(18, signal.confidence * 0.18) : 0,
        structure: supplyDemandConfirmed ? 25 : 0,
        regime: regimeSupported ? Math.min(15, regime.confidence * 0.15) : 0,
        momentum: weakTrend ? 12 : 0,
        location: boundaryAligned && bandExtreme ? 20 : boundaryAligned ? 15 : 0,
        multiTimeframe: context.multiTimeframe?.bias ? 3 : 5,
        session: sessionSupported && asianAllowed ? 5 : 0,
      },
      eligible,
      [
        supplyDemandConfirmed
          ? `Supply/Demand corridor confirms a tradeable range (${range!.demand.low.toFixed(2)}-${range!.supply.high.toFixed(2)}).`
          : "No qualified Supply/Demand corridor contains current price.",
        weakTrend ? "ADX confirms weak directional pressure." : "ADX is too strong for mean reversion.",
        boundaryAligned
          ? direction === SignalType.BUY
            ? "BUY is aligned with the demand/lower 30% boundary."
            : "SELL is aligned with the supply/upper 30% boundary."
          : "Price is in the middle of the range or signal direction is not aligned with the nearest boundary.",
        bandExtreme ? "Bollinger percent-B supports the range extreme." : "Bollinger percent-B is not extreme; Supply/Demand remains the primary location filter.",
      ],
      [
        "A confirmed BOS closes outside the Supply/Demand corridor.",
        "ADX expands above the approved range threshold.",
        "Price closes beyond the protected Supply/Demand boundary.",
      ],
      [],
      config,
    );
  }
}
