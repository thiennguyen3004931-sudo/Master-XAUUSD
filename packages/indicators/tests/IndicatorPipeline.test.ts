import { describe, expect, it } from "vitest";
import { IndicatorPipeline } from "../src";
import { createCandles } from "./fixtures";

describe("IndicatorPipeline", () => {
  it("creates a complete report without mutating candle input", () => {
    const candles = createCandles();
    const original = structuredClone(candles);
    const result = new IndicatorPipeline().calculate(candles);

    expect(result.symbol).toBe("XAUUSD");
    expect(result.candleCount).toBe(240);
    expect(result.series.sma["200"]?.length).toBe(240);
    expect(result.latest.rsi).not.toBeNull();
    expect(result.latest.adx.adx).not.toBeNull();
    expect(result.warmupComplete).toBe(true);
    expect(candles).toEqual(original);
  });

  it("supports compact custom periods", () => {
    const candles = createCandles(50);
    const result = new IndicatorPipeline().calculate(candles, {
      smaPeriods: [5, 10],
      emaPeriods: [5, 10],
    });

    expect(Object.keys(result.series.sma)).toEqual(["5", "10"]);
    expect(Object.keys(result.series.ema)).toEqual(["5", "10"]);
  });

  it("rejects duplicate or unsorted candles", () => {
    const candles = createCandles(30);
    candles[1] = { ...candles[1]!, openTime: candles[0]!.openTime };

    expect(() => new IndicatorPipeline().calculate(candles)).toThrow(
      /ordered by openTime/,
    );
  });
});
