import { MarketStructure, Trend, type SwingPoint } from "@xauusd/types";
import { TrendDetector } from "./TrendDetector";

export class MarketStructureDetector {
  readonly name = "MarketStructureDetector";

  constructor(private readonly trendDetector = new TrendDetector()) {}

  detect(swings: readonly SwingPoint[]): MarketStructure {
    const trend = this.trendDetector.detect(swings);

    if (trend === Trend.Bullish) {
      return MarketStructure.Bullish;
    }

    if (trend === Trend.Bearish) {
      return MarketStructure.Bearish;
    }

    return MarketStructure.Range;
  }
}
