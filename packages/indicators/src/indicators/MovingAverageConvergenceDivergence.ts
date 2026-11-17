import type { Candle } from "@xauusd/market-data";
import type { Indicator } from "@xauusd/types";
import type { MacdValue, NullableNumber, PriceSource } from "../models";
import {
  candlePrices,
  exponentialMovingAverage,
  exponentialMovingAverageNullable,
  NumberUtils,
} from "../utils";

export class MovingAverageConvergenceDivergence
  implements Indicator<readonly Candle[], MacdValue[]>
{
  readonly name: string;

  constructor(
    readonly fastPeriod = 12,
    readonly slowPeriod = 26,
    readonly signalPeriod = 9,
    readonly source: PriceSource = "close",
  ) {
    NumberUtils.assertPositiveInteger(fastPeriod, "fastPeriod");
    NumberUtils.assertPositiveInteger(slowPeriod, "slowPeriod");
    NumberUtils.assertPositiveInteger(signalPeriod, "signalPeriod");

    if (fastPeriod >= slowPeriod) {
      throw new RangeError("fastPeriod must be less than slowPeriod");
    }

    this.name = `MACD(${fastPeriod},${slowPeriod},${signalPeriod},${source})`;
  }

  calculate(candles: readonly Candle[]): MacdValue[] {
    const prices = candlePrices(candles, this.source);
    const fast = exponentialMovingAverage(prices, this.fastPeriod);
    const slow = exponentialMovingAverage(prices, this.slowPeriod);
    const macd: NullableNumber[] = prices.map((_, index) => {
      const fastValue = fast[index];
      const slowValue = slow[index];
      return fastValue === null || slowValue === null
        ? null
        : fastValue - slowValue;
    });
    const signal = exponentialMovingAverageNullable(macd, this.signalPeriod);

    return macd.map((macdValue, index) => {
      const signalValue = signal[index] ?? null;
      return {
        macd: macdValue,
        signal: signalValue,
        histogram:
          macdValue === null || signalValue === null
            ? null
            : macdValue - signalValue,
      };
    });
  }
}
