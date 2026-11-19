import type { Candle } from "@xauusd/market-data";
import type { FairValueGap } from "@xauusd/types";
import type { FairValueGapDetectionConfig } from "../config/AnalysisConfig";

export class FairValueGapDetector {
  readonly name = "FairValueGapDetector";

  detect(
    candles: readonly Candle[],
    config: FairValueGapDetectionConfig,
  ): FairValueGap[] {
    const gaps: FairValueGap[] = [];

    for (let index = 2; index < candles.length; index += 1) {
      const first = candles[index - 2]!;
      const third = candles[index]!;

      if (third.low > first.high) {
        const low = first.high;
        const high = third.low;
        if (high - low >= config.minimumSize) {
          gaps.push({
            id: `FVG-BULL-${third.openTime}`,
            low,
            high,
            bullish: true,
            filled: this.isBullishGapFilled(candles, index + 1, low),
            createdAt: third.openTime,
          });
        }
      }

      if (third.high < first.low) {
        const low = third.high;
        const high = first.low;
        if (high - low >= config.minimumSize) {
          gaps.push({
            id: `FVG-BEAR-${third.openTime}`,
            low,
            high,
            bullish: false,
            filled: this.isBearishGapFilled(candles, index + 1, high),
            createdAt: third.openTime,
          });
        }
      }
    }

    return gaps.slice(-config.maxZones);
  }

  private isBullishGapFilled(
    candles: readonly Candle[],
    startIndex: number,
    lowerBoundary: number,
  ): boolean {
    return candles.slice(startIndex).some((candle) => candle.low <= lowerBoundary);
  }

  private isBearishGapFilled(
    candles: readonly Candle[],
    startIndex: number,
    upperBoundary: number,
  ): boolean {
    return candles.slice(startIndex).some((candle) => candle.high >= upperBoundary);
  }
}
