import type { Candle } from "@xauusd/market-data";
import type { Indicator } from "@xauusd/types";
import type { NullableNumber, PriceSource } from "../models";
import { candlePrices, NumberUtils, simpleMovingAverage } from "../utils";

export class SimpleMovingAverage
  implements Indicator<readonly Candle[], NullableNumber[]>
{
  readonly name: string;

  constructor(
    readonly period = 20,
    readonly source: PriceSource = "close",
  ) {
    NumberUtils.assertPositiveInteger(period, "period");
    this.name = `SMA(${period},${source})`;
  }

  calculate(candles: readonly Candle[]): NullableNumber[] {
    return simpleMovingAverage(candlePrices(candles, this.source), this.period);
  }
}
