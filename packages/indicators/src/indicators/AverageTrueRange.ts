import type { Candle } from "@xauusd/market-data";
import type { Indicator } from "@xauusd/types";
import type { NullableNumber } from "../models";
import { NumberUtils, wilderMovingAverage } from "../utils";

export class AverageTrueRange
  implements Indicator<readonly Candle[], NullableNumber[]>
{
  readonly name: string;

  constructor(readonly period = 14) {
    NumberUtils.assertPositiveInteger(period, "period");
    this.name = `ATR(${period})`;
  }

  calculate(candles: readonly Candle[]): NullableNumber[] {
    const trueRanges = candles.map((candle, index) => {
      if (index === 0) {
        return candle.high - candle.low;
      }

      const previousClose = candles[index - 1]!.close;
      return Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previousClose),
        Math.abs(candle.low - previousClose),
      );
    });

    return wilderMovingAverage(trueRanges, this.period);
  }
}
