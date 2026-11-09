import type { Candle } from "@xauusd/market-data";

export class CandleUtils {
  static range(candle: Candle): number {
    return candle.high - candle.low;
  }

  static body(candle: Candle): number {
    return Math.abs(candle.close - candle.open);
  }

  static midpoint(candle: Candle): number {
    return (candle.high + candle.low) / 2;
  }

  static isBullish(candle: Candle): boolean {
    return candle.close > candle.open;
  }

  static isBearish(candle: Candle): boolean {
    return candle.close < candle.open;
  }

  static trueRange(candle: Candle, previous?: Candle): number {
    if (!previous) {
      return CandleUtils.range(candle);
    }

    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previous.close),
      Math.abs(candle.low - previous.close),
    );
  }

  static averageTrueRange(candles: readonly Candle[], period = 14): number {
    if (candles.length === 0) {
      return 0;
    }

    const normalizedPeriod = Math.max(1, Math.min(period, candles.length));
    const start = candles.length - normalizedPeriod;
    let total = 0;

    for (let index = start; index < candles.length; index += 1) {
      total += CandleUtils.trueRange(candles[index]!, candles[index - 1]);
    }

    return total / normalizedPeriod;
  }
}
