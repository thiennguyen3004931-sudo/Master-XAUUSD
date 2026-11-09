import type { Candle } from "@xauusd/market-data";

export class CandleSeriesValidator {
  validate(candles: readonly Candle[]): void {
    if (candles.length < 2) {
      throw new RangeError(
        "Backtest requires at least two candles.",
      );
    }

    const first = candles[0]!;
    for (let index = 0; index < candles.length; index += 1) {
      const candle = candles[index]!;
      if (
        candle.symbol !== first.symbol ||
        candle.timeframe !== first.timeframe
      ) {
        throw new Error(
          "All candles must share the same symbol and timeframe.",
        );
      }

      if (
        ![
          candle.openTime,
          candle.closeTime,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume,
        ].every(Number.isFinite)
      ) {
        throw new TypeError(
          `Candle ${index} contains a non-finite value.`,
        );
      }

      if (
        candle.openTime >= candle.closeTime ||
        candle.high < Math.max(candle.open, candle.close) ||
        candle.low > Math.min(candle.open, candle.close) ||
        candle.low > candle.high ||
        candle.volume < 0
      ) {
        throw new Error(
          `Candle ${index} has invalid OHLC or timestamp values.`,
        );
      }

      if (
        index > 0 &&
        candle.openTime <= candles[index - 1]!.openTime
      ) {
        throw new Error(
          "Candles must be strictly ordered by openTime.",
        );
      }
    }
  }
}
