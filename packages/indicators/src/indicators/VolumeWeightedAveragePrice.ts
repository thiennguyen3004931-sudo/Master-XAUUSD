import type { Candle } from "@xauusd/market-data";
import type { Indicator } from "@xauusd/types";
import type { NullableNumber } from "../models";

export class VolumeWeightedAveragePrice
  implements Indicator<readonly Candle[], NullableNumber[]>
{
  readonly name = "VWAP";

  calculate(candles: readonly Candle[]): NullableNumber[] {
    let cumulativePriceVolume = 0;
    let cumulativeVolume = 0;

    return candles.map((candle) => {
      const typicalPrice = (candle.high + candle.low + candle.close) / 3;
      cumulativePriceVolume += typicalPrice * candle.volume;
      cumulativeVolume += candle.volume;

      return cumulativeVolume === 0
        ? null
        : cumulativePriceVolume / cumulativeVolume;
    });
  }
}
