import type { Candle } from "@xauusd/market-data";
import type { Indicator } from "@xauusd/types";
import type { NullableNumber, PriceSource } from "../models";
import { candlePrices, NumberUtils } from "../utils";

export class RelativeStrengthIndex
  implements Indicator<readonly Candle[], NullableNumber[]>
{
  readonly name: string;

  constructor(
    readonly period = 14,
    readonly source: PriceSource = "close",
  ) {
    NumberUtils.assertPositiveInteger(period, "period");
    this.name = `RSI(${period},${source})`;
  }

  calculate(candles: readonly Candle[]): NullableNumber[] {
    const prices = candlePrices(candles, this.source);
    const result: NullableNumber[] = Array(prices.length).fill(null);

    if (prices.length <= this.period) {
      return result;
    }

    let gainSum = 0;
    let lossSum = 0;

    for (let index = 1; index <= this.period; index += 1) {
      const change = prices[index]! - prices[index - 1]!;
      gainSum += Math.max(change, 0);
      lossSum += Math.max(-change, 0);
    }

    let averageGain = gainSum / this.period;
    let averageLoss = lossSum / this.period;
    result[this.period] = this.toRsi(averageGain, averageLoss);

    for (let index = this.period + 1; index < prices.length; index += 1) {
      const change = prices[index]! - prices[index - 1]!;
      const gain = Math.max(change, 0);
      const loss = Math.max(-change, 0);

      averageGain = ((averageGain * (this.period - 1)) + gain) / this.period;
      averageLoss = ((averageLoss * (this.period - 1)) + loss) / this.period;
      result[index] = this.toRsi(averageGain, averageLoss);
    }

    return result;
  }

  private toRsi(averageGain: number, averageLoss: number): number {
    if (averageLoss === 0) {
      return averageGain === 0 ? 50 : 100;
    }

    const relativeStrength = averageGain / averageLoss;
    return 100 - (100 / (1 + relativeStrength));
  }
}
