import type { Candle } from "@xauusd/market-data";

export class IndicatorInputValidator {
  validate(candles: readonly Candle[]): void {
    if (candles.length === 0) {
      throw new RangeError("At least one candle is required");
    }

    const first = candles[0]!;

    candles.forEach((candle, index) => {
      const numericValues = [
        candle.openTime,
        candle.closeTime,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
      ];

      if (numericValues.some((value) => !Number.isFinite(value))) {
        throw new TypeError(`Candle at index ${index} contains a non-finite value`);
      }

      if (candle.symbol !== first.symbol || candle.timeframe !== first.timeframe) {
        throw new RangeError("All candles must use the same symbol and timeframe");
      }

      if (candle.closeTime < candle.openTime) {
        throw new RangeError(`Candle at index ${index} has an invalid time range`);
      }

      if (
        candle.high < Math.max(candle.open, candle.close, candle.low)
        || candle.low > Math.min(candle.open, candle.close, candle.high)
      ) {
        throw new RangeError(`Candle at index ${index} has invalid OHLC values`);
      }

      if (candle.volume < 0) {
        throw new RangeError(`Candle at index ${index} has negative volume`);
      }

      if (index > 0 && candle.openTime <= candles[index - 1]!.openTime) {
        throw new RangeError("Candles must be ordered by openTime without duplicates");
      }
    });
  }
}
