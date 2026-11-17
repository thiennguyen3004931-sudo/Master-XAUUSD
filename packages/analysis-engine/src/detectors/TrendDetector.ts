import { SwingType, Trend, type SwingPoint } from "@xauusd/types";

export class TrendDetector {
  readonly name = "TrendDetector";

  detect(swings: readonly SwingPoint[]): Trend {
    const highs = swings.filter((swing) => swing.type === SwingType.High);
    const lows = swings.filter((swing) => swing.type === SwingType.Low);

    if (highs.length < 2 || lows.length < 2) {
      return Trend.Ranging;
    }

    const previousHigh = highs.at(-2)!;
    const latestHigh = highs.at(-1)!;
    const previousLow = lows.at(-2)!;
    const latestLow = lows.at(-1)!;

    const higherHigh = latestHigh.price > previousHigh.price;
    const higherLow = latestLow.price > previousLow.price;
    const lowerHigh = latestHigh.price < previousHigh.price;
    const lowerLow = latestLow.price < previousLow.price;

    if (higherHigh && higherLow) {
      return Trend.Bullish;
    }

    if (lowerHigh && lowerLow) {
      return Trend.Bearish;
    }

    return Trend.Ranging;
  }
}
