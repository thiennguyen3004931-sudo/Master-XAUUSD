import { describe, expect, it } from "vitest";
import {
  BacktestConfigValidator,
  CandleSeriesValidator,
  defaultBacktestConfig,
} from "../src";
import { createCandles } from "./fixtures";

describe("backtest validation", () => {
  it("rejects invalid contract size", () => {
    expect(() =>
      new BacktestConfigValidator().validate({
        ...defaultBacktestConfig,
        contractSize: 0,
      }),
    ).toThrow();
  });

  it("rejects duplicate candle timestamps", () => {
    const candles = createCandles([100, 101, 102]);
    candles[1] = {
      ...candles[1]!,
      openTime: candles[0]!.openTime,
    };

    expect(() =>
      new CandleSeriesValidator().validate(candles),
    ).toThrow();
  });
});
