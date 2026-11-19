import { Trend } from "@xauusd/types";
import type { ISignalRule } from "../contracts";
import type { SignalEngineConfig } from "../config";
import type { SignalContext, SignalRuleResult } from "../models";
import { NumberUtils, RuleResultFactory } from "../utils";

const WEIGHT = 15;

function zoneDistance(
  close: number,
  low: number,
  high: number,
): number {
  if (close < low) return low - close;
  if (close > high) return close - high;
  return 0;
}

function overlaps(
  aLow: number,
  aHigh: number,
  bLow: number,
  bHigh: number,
): boolean {
  return Math.max(aLow, bLow) <= Math.min(aHigh, bHigh);
}

export class SupplyDemandConfluenceRule implements ISignalRule {
  readonly name = "SupplyDemandConfluenceRule";

  evaluate(
    context: SignalContext,
    _config: SignalEngineConfig,
  ): SignalRuleResult {
    const close = context.indicators.latest.close;
    const atr =
      context.indicators.latest.atr ??
      context.analysis.metrics.averageTrueRange;

    if (!NumberUtils.isFinitePositive(atr)) {
      return RuleResultFactory.neutral(
        this.name,
        WEIGHT,
        "ATR is unavailable for Supply/Demand distance",
      );
    }

    const bullish = context.analysis.trend === Trend.Bullish;
    const bearish = context.analysis.trend === Trend.Bearish;

    if (!bullish && !bearish) {
      return RuleResultFactory.neutral(
        this.name,
        WEIGHT,
        "Primary trend is not directional",
      );
    }

    const targetType = bullish ? "DEMAND" : "SUPPLY";

    const zones = (context.analysis.supplyDemandZones ?? [])
      .filter(
        (zone) =>
          zone.active &&
          zone.type === targetType,
      );

    if (zones.length === 0) {
      return RuleResultFactory.neutral(
        this.name,
        WEIGHT,
        `No active ${targetType.toLowerCase()} zone supports the primary trend`,
      );
    }

    const nearest = zones
      .map((zone) => ({
        zone,
        distance: zoneDistance(close, zone.low, zone.high),
      }))
      .sort((a, b) => a.distance - b.distance)[0]!;

    const alignedFvg = context.analysis.fairValueGaps.some(
      (gap) =>
        !gap.filled &&
        gap.bullish === bullish &&
        overlaps(
          nearest.zone.low,
          nearest.zone.high,
          gap.low,
          gap.high,
        ),
    );

    const distanceAtr = nearest.distance / atr;
    const direction = bullish ? "BULLISH" : "BEARISH";

    if (nearest.distance === 0 || distanceAtr <= 0.5) {
      return RuleResultFactory.create(
        this.name,
        WEIGHT,
        direction,
        alignedFvg ? 1 : nearest.distance === 0 ? 0.95 : 0.8,
        alignedFvg
          ? `${targetType} overlaps a trend-aligned FVG near the pullback entry`
          : `Price is at or near an active ${targetType.toLowerCase()} pullback zone`,
        {
          low: nearest.zone.low,
          high: nearest.zone.high,
          strength: nearest.zone.strength,
          alignedFvg,
          distanceAtr,
        },
      );
    }

    if (distanceAtr <= 1.5) {
      return RuleResultFactory.create(
        this.name,
        WEIGHT,
        direction,
        0.6,
        `Active ${targetType.toLowerCase()} exists but price is not yet at the preferred pullback entry`,
        {
          low: nearest.zone.low,
          high: nearest.zone.high,
          alignedFvg,
          distanceAtr,
        },
      );
    }

    return RuleResultFactory.neutral(
      this.name,
      WEIGHT,
      `Nearest active ${targetType.toLowerCase()} zone is too distant`,
      { distanceAtr },
    );
  }
}