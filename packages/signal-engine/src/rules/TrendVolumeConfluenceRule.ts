import { Trend } from "@xauusd/types";
import type { ISignalRule } from "../contracts";
import type { SignalEngineConfig } from "../config";
import type { SignalContext, SignalRuleResult } from "../models";
import { RuleResultFactory } from "../utils";

const WEIGHT = 10;

export class TrendVolumeConfluenceRule implements ISignalRule {
  readonly name = "TrendVolumeConfluenceRule";

  evaluate(
    context: SignalContext,
    _config: SignalEngineConfig,
  ): SignalRuleResult {
    const candle = context.analysis.lastCandle;
    const average = context.indicators.latest.volumeSma;

    if (!candle || average === null || average <= 0) {
      return RuleResultFactory.neutral(
        this.name,
        WEIGHT,
        "Volume confirmation is unavailable",
      );
    }

    const ratio = candle.volume / average;

    if (ratio < 1.05 || candle.close === candle.open) {
      return RuleResultFactory.neutral(
        this.name,
        WEIGHT,
        "Volume is not above its moving average",
        { ratio },
      );
    }

    const bullishCandle = candle.close > candle.open;
    const bearishCandle = candle.close < candle.open;

    const bullishAligned =
      context.analysis.trend === Trend.Bullish &&
      bullishCandle;

    const bearishAligned =
      context.analysis.trend === Trend.Bearish &&
      bearishCandle;

    if (!bullishAligned && !bearishAligned) {
      return RuleResultFactory.neutral(
        this.name,
        WEIGHT,
        "Volume expansion candle conflicts with the primary trend",
        { ratio },
      );
    }

    const direction = bullishAligned ? "BULLISH" : "BEARISH";
    const strength = Math.min(
      1,
      0.55 + (ratio - 1.05) / 0.8,
    );

    return RuleResultFactory.create(
      this.name,
      WEIGHT,
      direction,
      strength,
      `Above-average volume confirms ${direction.toLowerCase()} trend continuation`,
      {
        ratio,
        volume: candle.volume,
        volumeAverage: average,
      },
    );
  }
}