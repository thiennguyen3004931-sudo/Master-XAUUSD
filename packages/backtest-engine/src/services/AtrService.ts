import type { Candle } from "@xauusd/market-data";

export class AtrService {
  calculate(
    candles: readonly Candle[],
    endIndex: number,
    period: number,
  ): number {
    if (endIndex <= 0 || period <= 0) return 0;

    const start = Math.max(1, endIndex - period + 1);
    const trueRanges: number[] = [];

    for (let index = start; index <= endIndex; index += 1) {
      const candle = candles[index]!;
      const previousClose = candles[index - 1]!.close;
      trueRanges.push(
        Math.max(
          candle.high - candle.low,
          Math.abs(candle.high - previousClose),
          Math.abs(candle.low - previousClose),
        ),
      );
    }

    return trueRanges.length === 0
      ? 0
      : trueRanges.reduce((sum, value) => sum + value, 0) /
          trueRanges.length;
  }
}
