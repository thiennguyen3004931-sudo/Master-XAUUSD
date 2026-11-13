import type { Candle } from "@xauusd/market-data";
import type { Indicator } from "@xauusd/types";
import type { NullableNumber, PriceSource } from "../models";
import { candlePrices, exponentialMovingAverage, NumberUtils } from "../utils";

export class ExponentialMovingAverage
  implements Indicator<readonly Candle[], NullableNumber[]>
{
  readonly name: string;

  constructor(
    readonly period = 20,
    readonly source: PriceSource = "close",
  ) {
    NumberUtils.assertPositiveInteger(period, "period");
    this.name = `EMA(${period},${source})`;
  }

  calculate(candles: readonly Candle[]): NullableNumber[] {
    return exponentialMovingAverage(
      candlePrices(candles, this.source),
      this.period,
    );
  }
}
