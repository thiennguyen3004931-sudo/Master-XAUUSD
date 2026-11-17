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

export class TrendFvgConfluenceRule implements ISignalRule {
  readonly name = "TrendFvgConfluenceRule";

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
        "ATR is unavailable for trend-aligned FVG distance",
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

    const gaps = context.analysis.fairValueGaps.filter(
      (gap) =>
        !gap.filled &&
        (bullish ? gap.bullish : !gap.bullish),
    );

    if (gaps.length === 0) {
      return RuleResultFactory.neutral(
        this.name,
        WEIGHT,
        "No unfilled FVG is aligned with the primary trend",
      );
    }

    const nearest = gaps
      .map((gap) => ({
        gap,
        distance: zoneDistance(close, gap.low, gap.high),
      }))
      .sort((a, b) => a.distance - b.distance)[0]!;

    const distanceAtr = nearest.distance / atr;
    const direction = bullish ? "BULLISH" : "BEARISH";

    if (nearest.distance === 0) {
      return RuleResultFactory.create(
        this.name,
        WEIGHT,
        direction,
        1,
        "Price is inside an unfilled trend-aligned FVG pullback zone",
        {
          low: nearest.gap.low,
          high: nearest.gap.high,
          distanceAtr,
        },
      );
    }

    if (distanceAtr <= 0.5) {
      return RuleResultFactory.create(
        this.name,
        WEIGHT,
        direction,
        0.8,
        "Price is approaching a trend-aligned FVG pullback zone",
        {
          low: nearest.gap.low,
          high: nearest.gap.high,
          distanceAtr,
        },
      );
    }

    if (distanceAtr <= 1.5) {
      return RuleResultFactory.create(
        this.name,
        WEIGHT,
        direction,
        0.5,
        "Trend-aligned FVG exists but pullback is not yet at the preferred entry zone",
        {
          low: nearest.gap.low,
          high: nearest.gap.high,
          distanceAtr,
        },
      );
    }

    return RuleResultFactory.neutral(
      this.name,
      WEIGHT,
      "Nearest trend-aligned FVG is too distant for the current pullback",
      { distanceAtr },
    );
  }
}