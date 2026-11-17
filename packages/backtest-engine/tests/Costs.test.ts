import { describe, expect, it } from "vitest";
import { OrderSide } from "@xauusd/types";
import {
  BacktestEngine,
  FixedCommissionPerLotModel,
  FixedTickSlippageModel,
} from "../src";
import {
  createCandles,
  executeEvaluation,
  waitEvaluation,
} from "./fixtures";

describe("execution costs", () => {
  it("deducts commission, spread and slippage", async () => {
    const candles = createCandles([100, 100, 102, 103], 0.2);
    candles[2] = {
      ...candles[2]!,
      open: 100,
      high: 103,
      low: 99.5,
      close: 102,
      spread: 0.2,
    };

    const engine = new BacktestEngine({
      commissionModel:
        new FixedCommissionPerLotModel(3.5),
      slippageModel:
        new FixedTickSlippageModel(1),
    });

    const result = await engine.run({
      candles,
      strategyEvaluator: {
        evaluate: ({ currentIndex, currentCandle }) =>
          currentIndex === 0
            ? executeEvaluation(
                OrderSide.BUY,
                currentCandle.closeTime,
                100,
                99,
                102,
              )
            : waitEvaluation(currentCandle.closeTime),
      },
      config: {
        warmupBars: 0,
        contractSize: 100,
        tickSize: 0.01,
      },
    });

    expect(result.trades[0]!.commission).toBe(7);
    expect(result.trades[0]!.netPnl).toBeLessThan(200);
  });
});
