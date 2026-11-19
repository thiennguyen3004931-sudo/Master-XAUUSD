import type { Candle } from "@xauusd/market-data";
import type { AnalysisMetrics } from "../models/AnalysisMetrics";
import { CandleUtils } from "../utils/CandleUtils";
import { NumberUtils } from "../utils/NumberUtils";

export class AnalysisMetricsService {
  calculate(candles: readonly Candle[]): AnalysisMetrics {
    if (candles.length === 0) {
      return {
        averageTrueRange: 0,
        volatilityPercent: 0,
        rangeHigh: 0,
        rangeLow: 0,
        rangeSize: 0,
        dataQuality: 0,
      };
    }

    const rangeHigh = Math.max(...candles.map((candle) => candle.high));
    const rangeLow = Math.min(...candles.map((candle) => candle.low));
    const rangeSize = rangeHigh - rangeLow;
    const averageTrueRange = CandleUtils.averageTrueRange(candles, 14);
    const latestClose = candles.at(-1)!.close;
    const volatilityPercent = latestClose === 0
      ? 0
      : (averageTrueRange / latestClose) * 100;

    const validCandles = candles.filter((candle) =>
      [candle.open, candle.high, candle.low, candle.close, candle.volume].every(
        Number.isFinite,
      ),
    ).length;

    return {
      averageTrueRange,
      volatilityPercent,
      rangeHigh,
      rangeLow,
      rangeSize,
      dataQuality: NumberUtils.clamp(
        (validCandles / candles.length) * 100,
        0,
        100,
      ),
    };
  }
}
