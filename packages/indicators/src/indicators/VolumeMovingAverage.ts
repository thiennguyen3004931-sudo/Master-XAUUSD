import type { Candle } from "@xauusd/market-data";
import type { Indicator } from "@xauusd/types";
import type { NullableNumber } from "../models";
import { NumberUtils, simpleMovingAverage } from "../utils";

export class VolumeMovingAverage
  implements Indicator<readonly Candle[], NullableNumber[]>
{
  readonly name: string;

  constructor(readonly period = 20) {
    NumberUtils.assertPositiveInteger(period, "period");
    this.name = `VOLUME_SMA(${period})`;
  }

  calculate(candles: readonly Candle[]): NullableNumber[] {
    return simpleMovingAverage(
      candles.map((candle) => candle.volume),
      this.period,
    );
  }
}
