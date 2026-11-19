import { MarketStructure, Trend } from "@xauusd/types";
import type { SignalEngineConfig } from "../config";
import type {
  SignalContext,
  SignalDiagnostics,
  SignalRejectionCode,
  SignalScore,
} from "../models";

function distanceToZone(
  close: number,
  low: number,
  high: number,
): number {
  if (close < low) return low - close;
  if (close > high) return close - high;
  return 0;
}

export class SignalEligibilityService {
  evaluate(
    context: SignalContext,
    score: SignalScore,
    config: SignalEngineConfig,
  ): SignalDiagnostics {
    const rejectionCodes: SignalRejectionCode[] = [];
    const notes: string[] = [];
    const volatility = context.analysis.metrics.volatilityPercent;

    if (score.direction === "NEUTRAL") {
      rejectionCodes.push("NO_DIRECTION");
    }

    if (
      config.requireIndicatorWarmup &&
      !context.indicators.warmupComplete
    ) {
      rejectionCodes.push("INDICATOR_WARMUP_INCOMPLETE");
    }

    if (context.analysis.score < config.minimumAnalysisScore) {
      rejectionCodes.push("ANALYSIS_SCORE_TOO_LOW");
    }

    if (
      context.analysis.metrics.dataQuality <
      config.minimumDataQuality
    ) {
      rejectionCodes.push("DATA_QUALITY_TOO_LOW");
    }

    if (volatility < config.minimumVolatilityPercent) {
      rejectionCodes.push("VOLATILITY_TOO_LOW");
    }

    if (volatility > config.maximumVolatilityPercent) {
      rejectionCodes.push("VOLATILITY_TOO_HIGH");
    }

    if (score.confidence < config.minimumConfidence) {
      rejectionCodes.push("CONFIDENCE_TOO_LOW");
    }

    if (score.directionalEdge < config.minimumDirectionalEdge) {
      rejectionCodes.push("DIRECTIONAL_EDGE_TOO_LOW");
    }

    const bullishAligned =
      score.direction === "BULLISH" &&
      context.analysis.trend === Trend.Bullish &&
      context.analysis.structure === MarketStructure.Bullish;

    const bearishAligned =
      score.direction === "BEARISH" &&
      context.analysis.trend === Trend.Bearish &&
      context.analysis.structure === MarketStructure.Bearish;

    if (
      score.direction !== "NEUTRAL" &&
      !bullishAligned &&
      !bearishAligned
    ) {
      rejectionCodes.push("TREND_STRUCTURE_ALIGNMENT_REQUIRED");
    }

    const atr =
      context.indicators.latest.atr ??
      context.analysis.metrics.averageTrueRange;
    const close = context.indicators.latest.close;

    let pullbackAligned = false;

    if (
      score.direction !== "NEUTRAL" &&
      Number.isFinite(atr) &&
      atr > 0
    ) {
      const zoneType =
        score.direction === "BULLISH" ? "DEMAND" : "SUPPLY";
      const bullishDirection = score.direction === "BULLISH";

      const supplyDemandNear = (
        context.analysis.supplyDemandZones ?? []
      ).some(
        (zone) =>
          zone.active &&
          zone.type === zoneType &&
          distanceToZone(close, zone.low, zone.high) <= atr * 0.5,
      );

      const fvgNear = context.analysis.fairValueGaps.some(
        (gap) =>
          !gap.filled &&
          gap.bullish === bullishDirection &&
          distanceToZone(close, gap.low, gap.high) <= atr * 0.5,
      );

      pullbackAligned = supplyDemandNear || fvgNear;
    }

    if (
      score.direction !== "NEUTRAL" &&
      !pullbackAligned
    ) {
      rejectionCodes.push("PULLBACK_ZONE_REQUIRED");
    }

    if (
      context.multiTimeframe &&
      context.multiTimeframe.confidence >= 50
    ) {
      const biasDirection =
        context.multiTimeframe.bias === "BULLISH"
          ? "BULLISH"
          : context.multiTimeframe.bias === "BEARISH"
            ? "BEARISH"
            : "NEUTRAL";

      if (
        biasDirection !== "NEUTRAL" &&
        biasDirection !== score.direction
      ) {
        notes.push(
          "Multi-timeframe bias conflicts with the winning signal direction",
        );
      } else if (biasDirection === score.direction) {
        notes.push(
          "Multi-timeframe bias confirms the winning signal direction",
        );
      }
    }

    return {
      accepted: rejectionCodes.length === 0,
      rejectionCodes: [...new Set(rejectionCodes)],
      notes,
    };
  }
}