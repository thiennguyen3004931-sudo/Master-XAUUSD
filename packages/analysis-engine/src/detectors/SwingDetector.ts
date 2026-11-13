import type { Candle } from "@xauusd/market-data";
import { SwingType, type SwingPoint } from "@xauusd/types";
import type { SwingDetectionConfig } from "../config/AnalysisConfig";
import { NumberUtils } from "../utils/NumberUtils";

export class SwingDetector {
  readonly name = "SwingDetector";

  detect(
    candles: readonly Candle[],
    config: SwingDetectionConfig,
  ): SwingPoint[] {
    const { leftBars, rightBars } = config;

    if (!Number.isInteger(leftBars) || leftBars < 1) {
      throw new RangeError("leftBars must be a positive integer");
    }

    if (!Number.isInteger(rightBars) || rightBars < 1) {
      throw new RangeError("rightBars must be a positive integer");
    }

    const swings: SwingPoint[] = [];

    for (
      let index = leftBars;
      index < candles.length - rightBars;
      index += 1
    ) {
      const candle = candles[index]!;
      const left = candles.slice(index - leftBars, index);
      const right = candles.slice(index + 1, index + rightBars + 1);
      const neighbors = [...left, ...right];

      const isHigh = neighbors.every((item) => candle.high >= item.high) &&
        neighbors.some((item) => candle.high > item.high);
      const isLow = neighbors.every((item) => candle.low <= item.low) &&
        neighbors.some((item) => candle.low < item.low);

      if (isHigh) {
        swings.push(
          this.toSwingPoint(candles, index, SwingType.High, leftBars, rightBars),
        );
      }

      if (isLow) {
        swings.push(
          this.toSwingPoint(candles, index, SwingType.Low, leftBars, rightBars),
        );
      }
    }

    return swings.sort((left, right) => left.index - right.index);
  }

  private toSwingPoint(
    candles: readonly Candle[],
    index: number,
    type: SwingType,
    leftBars: number,
    rightBars: number,
  ): SwingPoint {
    const candle = candles[index]!;
    const start = Math.max(0, index - leftBars * 2);
    const end = Math.min(candles.length, index + rightBars * 2 + 1);
    const window = candles.slice(start, end);
    const rangeHigh = Math.max(...window.map((item) => item.high));
    const rangeLow = Math.min(...window.map((item) => item.low));
    const localRange = Math.max(Number.EPSILON, rangeHigh - rangeLow);
    const distance = type === SwingType.High
      ? candle.high - rangeLow
      : rangeHigh - candle.low;
    const strength = Math.round(
      NumberUtils.clamp((distance / localRange) * 5, 1, 5),
    );

    return {
      index,
      timestamp: candle.openTime,
      price: type === SwingType.High ? candle.high : candle.low,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      type,
      strength,
    };
  }
}
