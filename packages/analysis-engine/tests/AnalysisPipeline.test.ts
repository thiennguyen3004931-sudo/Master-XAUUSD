import { describe, expect, it } from "vitest";
import { Timeframe } from "@xauusd/market-data";
import { AnalysisPipeline } from "../src/pipeline/AnalysisPipeline";
import { createTrendingCandles } from "./fixtures";

describe("AnalysisPipeline", () => {
  it("returns a complete immutable analysis snapshot", () => {
    const candles = createTrendingCandles();
    const result = new AnalysisPipeline().analyze(
      "XAUUSD",
      Timeframe.M1,
      candles,
    );

    expect(result.symbol).toBe("XAUUSD");
    expect(result.timeframe).toBe(Timeframe.M1);
    expect(result.lastCandle).not.toBeNull();
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.metrics.dataQuality).toBe(100);
    expect(result.premiumZone).toBeGreaterThan(result.equilibrium);
    expect(result.discountZone).toBeLessThan(result.equilibrium);
  });

  it("rejects unsorted candles", () => {
    const candles = createTrendingCandles();
    [candles[0], candles[1]] = [candles[1]!, candles[0]!];

    expect(() =>
      new AnalysisPipeline().analyze("XAUUSD", Timeframe.M1, candles),
    ).toThrow(/ordered by openTime/);
  });
});
