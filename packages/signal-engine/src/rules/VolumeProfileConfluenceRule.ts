import { Trend } from "@xauusd/types";
import type { ISignalRule } from "../contracts";
import type { SignalEngineConfig } from "../config";
import type { SignalContext, SignalRuleResult } from "../models";
import { NumberUtils, RuleResultFactory } from "../utils";

const WEIGHT = 15;

function nearestDistance(
  close: number,
  prices: readonly number[],
): number {
  if (prices.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.min(...prices.map((price) => Math.abs(close - price)));
}

export class VolumeProfileConfluenceRule implements ISignalRule {
  readonly name = "VolumeProfileConfluenceRule";

  evaluate(
    context: SignalContext,
    _config: SignalEngineConfig,
  ): SignalRuleResult {
    const profile = context.analysis.volumeProfile;
    const close = context.indicators.latest.close;
    const atr =
      context.indicators.latest.atr ??
      context.analysis.metrics.averageTrueRange;

    if (
      !profile ||
      !NumberUtils.isFinitePositive(profile.poc) ||
      !NumberUtils.isFinitePositive(atr)
    ) {
      return RuleResultFactory.neutral(
        this.name,
        WEIGHT,
        "Volume Profile is unavailable",
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

    const direction = bullish ? "BULLISH" : "BEARISH";
    const hvnDistance = nearestDistance(
      close,
      profile.hvn.map((node) => node.price),
    );
    const lvnDistance = nearestDistance(
      close,
      profile.lvn.map((node) => node.price),
    );
    const pocDistance = Math.abs(close - profile.poc);
    const supportDistance = Math.min(pocDistance, hvnDistance);

    if (supportDistance <= atr * 0.75) {
      return RuleResultFactory.create(
        this.name,
        WEIGHT,
        direction,
        1,
        "POC/HVN is close enough to support the trend-following pullback",
        {
          poc: profile.poc,
          pocDistanceAtr: pocDistance / atr,
          hvnDistanceAtr: hvnDistance / atr,
        },
      );
    }

    if (lvnDistance <= atr * 0.5) {
      return RuleResultFactory.create(
        this.name,
        WEIGHT,
        direction,
        0.7,
        "Nearby LVN provides a Volume Profile transition reference for the pullback",
        {
          poc: profile.poc,
          lvnDistanceAtr: lvnDistance / atr,
        },
      );
    }

    const trendSide =
      (bullish && close > profile.poc) ||
      (bearish && close < profile.poc);

    if (trendSide) {
      return RuleResultFactory.create(
        this.name,
        WEIGHT,
        direction,
        0.45,
        "Price remains on the trend side of Volume Profile POC",
        {
          close,
          poc: profile.poc,
        },
      );
    }

    return RuleResultFactory.neutral(
      this.name,
      WEIGHT,
      "Volume Profile location does not currently confirm the trend pullback",
      {
        close,
        poc: profile.poc,
      },
    );
  }
}