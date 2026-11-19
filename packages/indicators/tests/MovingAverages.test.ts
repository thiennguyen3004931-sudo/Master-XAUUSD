import { describe, expect, it } from "vitest";
import {
  ExponentialMovingAverage,
  SimpleMovingAverage,
} from "../src";
import { createCandles } from "./fixtures";

describe("moving averages", () => {
  it("calculates an aligned SMA series", () => {
    const candles = createCandles(5, (index) => index + 1);
    const result = new SimpleMovingAverage(3).calculate(candles);

    expect(result).toEqual([null, null, 2, 3, 4]);
  });

  it("seeds EMA with the first period SMA", () => {
    const candles = createCandles(5, (index) => index + 1);
    const result = new ExponentialMovingAverage(3).calculate(candles);

    expect(result).toEqual([null, null, 2, 3, 4]);
  });
});
