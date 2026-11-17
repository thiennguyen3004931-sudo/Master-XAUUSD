import { describe, expect, it } from "vitest";
import {
  MovingAverageConvergenceDivergence,
  VolumeWeightedAveragePrice,
} from "../src";
import { createCandles } from "./fixtures";

describe("MACD and VWAP", () => {
  it("aligns MACD, signal and histogram with candle history", () => {
    const candles = createCandles(80);
    const result = new MovingAverageConvergenceDivergence().calculate(candles);
    const latest = result.at(-1)!;

    expect(result).toHaveLength(candles.length);
    expect(latest.macd).not.toBeNull();
    expect(latest.signal).not.toBeNull();
    expect(latest.histogram).toBeCloseTo(latest.macd! - latest.signal!, 12);
  });

  it("calculates cumulative VWAP", () => {
    const candles = createCandles(10);
    const result = new VolumeWeightedAveragePrice().calculate(candles);

    expect(result).toHaveLength(10);
    expect(result.at(-1)).not.toBeNull();
  });
});
