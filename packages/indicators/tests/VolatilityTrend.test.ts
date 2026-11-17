import { describe, expect, it } from "vitest";
import {
  AverageDirectionalIndex,
  AverageTrueRange,
  BollingerBands,
} from "../src";
import { createCandles } from "./fixtures";

describe("volatility and trend indicators", () => {
  it("calculates ATR using Wilder smoothing", () => {
    const candles = createCandles(30, (index) => 2000 + index);
    const result = new AverageTrueRange(14).calculate(candles);

    expect(result.at(-1)).not.toBeNull();
    expect(result.at(-1)!).toBeGreaterThan(0);
  });

  it("returns ordered Bollinger bands", () => {
    const candles = createCandles(30, (index) => 2000 + Math.sin(index));
    const latest = new BollingerBands(20, 2).calculate(candles).at(-1)!;

    expect(latest.upper!).toBeGreaterThan(latest.middle!);
    expect(latest.middle!).toBeGreaterThan(latest.lower!);
  });

  it("produces ADX and directional indexes after warmup", () => {
    const candles = createCandles(60, (index) => 2000 + index);
    const latest = new AverageDirectionalIndex(14).calculate(candles).at(-1)!;

    expect(latest.adx).not.toBeNull();
    expect(latest.plusDI).not.toBeNull();
    expect(latest.minusDI).not.toBeNull();
  });
});
