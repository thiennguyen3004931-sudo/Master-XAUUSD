import { describe, expect, it } from "vitest";
import {
  RelativeStrengthIndex,
  StochasticOscillator,
} from "../src";
import { createCandles } from "./fixtures";

describe("oscillators", () => {
  it("returns RSI 100 for a continuously rising market", () => {
    const candles = createCandles(20, (index) => 100 + index);
    const result = new RelativeStrengthIndex(14).calculate(candles);

    expect(result.at(-1)).toBe(100);
  });

  it("keeps stochastic values inside the expected range", () => {
    const candles = createCandles(30, (index) => 100 + Math.sin(index / 2));
    const result = new StochasticOscillator(14, 3).calculate(candles);
    const latest = result.at(-1)!;

    expect(latest.k).not.toBeNull();
    expect(latest.d).not.toBeNull();
    expect(latest.k!).toBeGreaterThanOrEqual(0);
    expect(latest.k!).toBeLessThanOrEqual(100);
  });
});
