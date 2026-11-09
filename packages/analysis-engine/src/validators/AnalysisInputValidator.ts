import type { Candle, Timeframe } from "@xauusd/market-data";
import type { AnalysisConfig } from "../config/AnalysisConfig";

export class AnalysisInputValidator {
  validate(
    symbol: string,
    timeframe: Timeframe,
    candles: readonly Candle[],
    config: AnalysisConfig,
  ): void {
    if (!symbol.trim()) {
      throw new Error("symbol is required");
    }

    if (!timeframe) {
      throw new Error("timeframe is required");
    }

    if (candles.length < config.minCandles) {
      throw new RangeError(
        `at least ${config.minCandles} candles are required for analysis`,
      );
    }

    let previousOpenTime = Number.NEGATIVE_INFINITY;
    const normalizedSymbol = symbol.trim().toUpperCase();

    candles.forEach((candle, index) => {
      if (candle.symbol.trim().toUpperCase() !== normalizedSymbol) {
        throw new Error(`candle at index ${index} belongs to another symbol`);
      }

      if (candle.timeframe !== timeframe) {
        throw new Error(`candle at index ${index} belongs to another timeframe`);
      }

      if (candle.openTime <= previousOpenTime) {
        throw new Error("candles must be strictly ordered by openTime");
      }

      previousOpenTime = candle.openTime;

      const prices = [candle.open, candle.high, candle.low, candle.close];
      if (prices.some((price) => !Number.isFinite(price) || price <= 0)) {
        throw new Error(`candle at index ${index} contains an invalid price`);
      }

      if (candle.high < Math.max(candle.open, candle.close, candle.low)) {
        throw new Error(`candle at index ${index} has an invalid high`);
      }

      if (candle.low > Math.min(candle.open, candle.close, candle.high)) {
        throw new Error(`candle at index ${index} has an invalid low`);
      }

      if (candle.closeTime < candle.openTime) {
        throw new Error(`candle at index ${index} has an invalid closeTime`);
      }
    });
  }
}
