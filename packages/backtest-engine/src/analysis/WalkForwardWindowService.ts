import type { Candle } from "@xauusd/market-data";
import type {
  WalkForwardConfig,
  WalkForwardWindow,
} from "../models";

export class WalkForwardWindowService {
  create(
    candles: readonly Candle[],
    config: WalkForwardConfig,
  ): WalkForwardWindow[] {
    for (const [name, value] of Object.entries(config)) {
      if (
        name !== "anchored" &&
        (!Number.isInteger(value) || value <= 0)
      ) {
        throw new RangeError(
          `${name} must be a positive integer.`,
        );
      }
    }

    const windows: WalkForwardWindow[] = [];
    let testingStart = config.trainingBars;
    let windowIndex = 0;

    while (
      testingStart + config.testingBars <= candles.length
    ) {
      const trainingStart = config.anchored
        ? 0
        : testingStart - config.trainingBars;
      const trainingEnd = testingStart - 1;
      const testingEnd =
        testingStart + config.testingBars - 1;

      windows.push({
        index: windowIndex,
        trainingStartIndex: trainingStart,
        trainingEndIndex: trainingEnd,
        testingStartIndex: testingStart,
        testingEndIndex: testingEnd,
        trainingCandles: candles.slice(
          trainingStart,
          testingStart,
        ),
        testingCandles: candles.slice(
          testingStart,
          testingEnd + 1,
        ),
      });

      testingStart += config.stepBars;
      windowIndex += 1;
    }

    return windows;
  }
}
