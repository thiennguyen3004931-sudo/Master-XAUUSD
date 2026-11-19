import { describe, expect, it } from "vitest";
import { OrderSide } from "@xauusd/types";
import {
  BacktestEngine,
  type IHistoricalStrategyEvaluator,
} from "../src";
import {
  START,
  createCandles,
  executeEvaluation,
  waitEvaluation,
} from "./fixtures";

describe("BacktestEngine", () => {
  it("fills on the next bar and closes a BUY at take profit", async () => {
    const candles = createCandles([100, 100, 100, 102, 103]);
    candles[3] = {
      ...candles[3]!,
      open: 100,
      high: 103,
      low: 99.5,
      close: 102,
    };

    const evaluator: IHistoricalStrategyEvaluator = {
      evaluate: ({ currentIndex, currentCandle }) =>
        currentIndex === 1
          ? executeEvaluation(
              OrderSide.BUY,
              currentCandle.closeTime,
              100,
              99,
              102,
            )
          : waitEvaluation(currentCandle.closeTime),
    };

    const result = await new BacktestEngine().run({
      candles,
      strategyEvaluator: evaluator,
      config: {
        initialBalance: 10_000,
        contractSize: 100,
        warmupBars: 0,
        fallbackSpread: 0,
      },
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.netPnl).toBe(200);
    expect(result.trades[0]!.exitReason).toBe("TAKE_PROFIT");
    expect(result.metrics.finalBalance).toBe(10_200);
  });

  it("never exposes future candles to the evaluator", async () => {
    const candles = createCandles([100, 101, 102, 103]);
    const observedLengths: number[] = [];

    await new BacktestEngine().run({
      candles,
      strategyEvaluator: {
        evaluate: (context) => {
          observedLengths.push(context.candles.length);
          expect(context.candles.length).toBe(
            context.currentIndex + 1,
          );
          return waitEvaluation(
            context.currentCandle.closeTime,
          );
        },
      },
      config: {
        warmupBars: 0,
        forceCloseAtEnd: false,
      },
    });

    expect(observedLengths).toEqual([1, 2, 3, 4]);
  });
});
