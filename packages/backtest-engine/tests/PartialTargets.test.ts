import { describe, expect, it } from "vitest";
import { OrderSide } from "@xauusd/types";
import { BacktestEngine } from "../src";
import {
  createCandles,
  executeEvaluation,
  waitEvaluation,
} from "./fixtures";

describe("partial targets", () => {
  it("closes 30%, 30% and 40% at TP1, TP2 and TP3", async () => {
    const candles = createCandles([100, 100, 103, 104]);
    candles[2] = {
      ...candles[2]!,
      open: 100,
      high: 103.5,
      low: 99.5,
      close: 103,
    };

    const result = await new BacktestEngine().run({
      candles,
      strategyEvaluator: {
        evaluate: ({ currentIndex, currentCandle }) =>
          currentIndex === 0
            ? executeEvaluation(
                OrderSide.BUY,
                currentCandle.closeTime,
                100,
                99,
                103,
                1,
                [
                  {
                    label: "TP1",
                    price: 101,
                    closePercent: 30,
                    rewardMultiple: 1,
                  },
                  {
                    label: "TP2",
                    price: 102,
                    closePercent: 30,
                    rewardMultiple: 2,
                  },
                  {
                    label: "TP3",
                    price: 103,
                    closePercent: 40,
                    rewardMultiple: 3,
                  },
                ],
              )
            : waitEvaluation(currentCandle.closeTime),
      },
      config: {
        warmupBars: 0,
        contractSize: 100,
        fallbackSpread: 0,
        intrabarPriority: "TARGET_FIRST",
      },
    });

    expect(result.trades).toHaveLength(1);
    expect(
      result.trades[0]!.partialExits.map((exit) => exit.volume),
    ).toEqual([0.3, 0.3, 0.4]);
    expect(result.trades[0]!.grossPnl).toBe(210);
  });
});
