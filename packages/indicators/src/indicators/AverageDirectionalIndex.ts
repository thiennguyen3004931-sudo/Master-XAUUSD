import type { Candle } from "@xauusd/market-data";
import type { Indicator } from "@xauusd/types";
import type { AdxValue, NullableNumber } from "../models";
import { NumberUtils } from "../utils";

export class AverageDirectionalIndex
  implements Indicator<readonly Candle[], AdxValue[]>
{
  readonly name: string;

  constructor(readonly period = 14) {
    NumberUtils.assertPositiveInteger(period, "period");
    this.name = `ADX(${period})`;
  }

  calculate(candles: readonly Candle[]): AdxValue[] {
    const length = candles.length;
    const result: AdxValue[] = Array.from({ length }, () => ({
      adx: null,
      plusDI: null,
      minusDI: null,
    }));

    if (length <= this.period) {
      return result;
    }

    const trueRange = Array<number>(length).fill(0);
    const plusDm = Array<number>(length).fill(0);
    const minusDm = Array<number>(length).fill(0);

    for (let index = 1; index < length; index += 1) {
      const current = candles[index]!;
      const previous = candles[index - 1]!;
      const upwardMove = current.high - previous.high;
      const downwardMove = previous.low - current.low;

      trueRange[index] = Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      );
      plusDm[index] = upwardMove > downwardMove && upwardMove > 0
        ? upwardMove
        : 0;
      minusDm[index] = downwardMove > upwardMove && downwardMove > 0
        ? downwardMove
        : 0;
    }

    let smoothedTr = trueRange.slice(1, this.period + 1)
      .reduce((sum, value) => sum + value, 0);
    let smoothedPlusDm = plusDm.slice(1, this.period + 1)
      .reduce((sum, value) => sum + value, 0);
    let smoothedMinusDm = minusDm.slice(1, this.period + 1)
      .reduce((sum, value) => sum + value, 0);
    const dx: NullableNumber[] = Array(length).fill(null);

    for (let index = this.period; index < length; index += 1) {
      if (index > this.period) {
        smoothedTr = smoothedTr - (smoothedTr / this.period) + trueRange[index]!;
        smoothedPlusDm = smoothedPlusDm
          - (smoothedPlusDm / this.period)
          + plusDm[index]!;
        smoothedMinusDm = smoothedMinusDm
          - (smoothedMinusDm / this.period)
          + minusDm[index]!;
      }

      const plusDI = smoothedTr === 0 ? 0 : (smoothedPlusDm / smoothedTr) * 100;
      const minusDI = smoothedTr === 0 ? 0 : (smoothedMinusDm / smoothedTr) * 100;
      const denominator = plusDI + minusDI;
      const currentDx = denominator === 0
        ? 0
        : (Math.abs(plusDI - minusDI) / denominator) * 100;

      result[index] = { adx: null, plusDI, minusDI };
      dx[index] = currentDx;
    }

    const firstAdxIndex = (this.period * 2) - 1;
    if (length <= firstAdxIndex) {
      return result;
    }

    const seedDx = dx
      .slice(this.period, firstAdxIndex + 1)
      .filter((value): value is number => value !== null);
    let previousAdx = NumberUtils.mean(seedDx);
    result[firstAdxIndex] = {
      ...result[firstAdxIndex]!,
      adx: previousAdx,
    };

    for (let index = firstAdxIndex + 1; index < length; index += 1) {
      const currentDx = dx[index];
      if (currentDx === null) {
        continue;
      }

      previousAdx = ((previousAdx * (this.period - 1)) + currentDx) / this.period;
      result[index] = {
        ...result[index]!,
        adx: previousAdx,
      };
    }

    return result;
  }
}
