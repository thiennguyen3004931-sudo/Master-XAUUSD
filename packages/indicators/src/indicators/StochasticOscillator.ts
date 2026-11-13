import type { Candle } from "@xauusd/market-data";
import type { Indicator } from "@xauusd/types";
import type { NullableNumber, StochasticValue } from "../models";
import {
  NumberUtils,
  simpleMovingAverageNullable,
} from "../utils";

export class StochasticOscillator
  implements Indicator<readonly Candle[], StochasticValue[]>
{
  readonly name: string;

  constructor(
    readonly period = 14,
    readonly signalPeriod = 3,
  ) {
    NumberUtils.assertPositiveInteger(period, "period");
    NumberUtils.assertPositiveInteger(signalPeriod, "signalPeriod");
    this.name = `STOCH(${period},${signalPeriod})`;
  }

  calculate(candles: readonly Candle[]): StochasticValue[] {
    const k: NullableNumber[] = candles.map((candle, index) => {
      if (index < this.period - 1) {
        return null;
      }

      const window = candles.slice(index - this.period + 1, index + 1);
      const highestHigh = Math.max(...window.map((item) => item.high));
      const lowestLow = Math.min(...window.map((item) => item.low));
      const range = highestHigh - lowestLow;

      return range === 0
        ? 50
        : ((candle.close - lowestLow) / range) * 100;
    });
    const d = simpleMovingAverageNullable(k, this.signalPeriod);

    return k.map((kValue, index) => ({
      k: kValue,
      d: d[index] ?? null,
    }));
  }
}
