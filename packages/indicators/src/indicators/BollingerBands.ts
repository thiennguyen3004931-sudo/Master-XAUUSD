import type { Candle } from "@xauusd/market-data";
import type { Indicator } from "@xauusd/types";
import type {
  BollingerBandsValue,
  PriceSource,
} from "../models";
import {
  candlePrices,
  NumberUtils,
  simpleMovingAverage,
} from "../utils";

export class BollingerBands
  implements Indicator<readonly Candle[], BollingerBandsValue[]>
{
  readonly name: string;

  constructor(
    readonly period = 20,
    readonly standardDeviations = 2,
    readonly source: PriceSource = "close",
  ) {
    NumberUtils.assertPositiveInteger(period, "period");
    NumberUtils.assertPositive(standardDeviations, "standardDeviations");
    this.name = `BB(${period},${standardDeviations},${source})`;
  }

  calculate(candles: readonly Candle[]): BollingerBandsValue[] {
    const prices = candlePrices(candles, this.source);
    const middle = simpleMovingAverage(prices, this.period);

    return prices.map((price, index) => {
      const middleValue = middle[index];
      if (middleValue === null || index < this.period - 1) {
        return {
          middle: null,
          upper: null,
          lower: null,
          bandwidth: null,
          percentB: null,
        };
      }

      const window = prices.slice(index - this.period + 1, index + 1);
      const deviation = NumberUtils.populationStandardDeviation(window);
      const upper = middleValue + (deviation * this.standardDeviations);
      const lower = middleValue - (deviation * this.standardDeviations);
      const width = upper - lower;

      return {
        middle: middleValue,
        upper,
        lower,
        bandwidth: middleValue === 0 ? null : width / middleValue,
        percentB: width === 0 ? 0.5 : (price - lower) / width,
      };
    });
  }
}
