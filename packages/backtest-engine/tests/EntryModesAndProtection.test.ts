import { describe, expect, it } from "vitest";
import { OrderSide } from "@xauusd/types";
import { BacktestEngine } from "../src";
import {
  createCandles,
  executeEvaluation,
  waitEvaluation,
} from "./fixtures";

describe("entry modes and protective stop management", () => {
  it("waits for the planned price in touch-entry mode", async () => {
    const candles = createCandles([100, 100, 100, 100, 102]);
    candles[1] = {
      ...candles[1]!,
      open: 100,
      high: 100.4,
      low: 99.8,
      close: 100,
    };
    candles[2] = {
      ...candles[2]!,
      open: 100,
      high: 100.2,
      low: 99.4,
      close: 99.8,
    };
    candles[3] = {
      ...candles[3]!,
      open: 99.8,
      high: 101.5,
      low: 99.6,
      close: 101,
    };

    const result = await new BacktestEngine().run({
      candles,
      strategyEvaluator: {
        evaluate: ({ currentIndex, currentCandle }) =>
          currentIndex === 0
            ? executeEvaluation(
                OrderSide.BUY,
                currentCandle.closeTime,
                99.5,
                98.5,
                101,
              )
            : waitEvaluation(currentCandle.closeTime),
      },
      config: {
        warmupBars: 0,
        contractSize: 100,
        fallbackSpread: 0,
        entryFillMode: "PLANNED_PRICE_TOUCH",
      },
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.entryTime).toBe(candles[2]!.openTime);
  });

  it("moves the stop to break-even only after a completed bar", async () => {
    const candles = createCandles([100, 100, 101.2, 101, 101]);
    candles[2] = {
      ...candles[2]!,
      open: 100,
      high: 101.3,
      low: 99.5,
      close: 101.2,
    };
    candles[3] = {
      ...candles[3]!,
      open: 101.2,
      high: 101.3,
      low: 99.9,
      close: 101,
    };

    const result = await new BacktestEngine().run({
      candles,
      strategyEvaluator: {
        evaluate: ({ currentIndex, currentCandle }) => {
          if (currentIndex !== 0) {
            return waitEvaluation(currentCandle.closeTime);
          }
          const evaluation = executeEvaluation(
            OrderSide.BUY,
            currentCandle.closeTime,
            100,
            99,
            110,
          );
          if (!evaluation.plan) throw new Error("Plan missing.");
          evaluation.plan.management.moveStopToBreakEvenAtR = 1;
          return evaluation;
        },
      },
      config: {
        warmupBars: 0,
        contractSize: 100,
        fallbackSpread: 0,
        breakEvenOffsetTicks: 1,
      },
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.exitReason).toBe("STOP_LOSS");
    expect(result.trades[0]!.averageExitPrice).toBe(100.01);
    expect(result.trades[0]!.netPnl).toBe(1);
  });

  it("advances an ATR trailing stop without widening it", async () => {
    const candles = createCandles([100, 100, 103, 101, 101]);
    candles[1] = {
      ...candles[1]!,
      open: 100,
      high: 100.4,
      low: 99.6,
      close: 100,
    };
    candles[2] = {
      ...candles[2]!,
      open: 100,
      high: 103.2,
      low: 99.7,
      close: 103,
    };
    candles[3] = {
      ...candles[3]!,
      open: 103,
      high: 103.1,
      low: 100.5,
      close: 101,
    };

    const result = await new BacktestEngine().run({
      candles,
      strategyEvaluator: {
        evaluate: ({ currentIndex, currentCandle }) => {
          if (currentIndex !== 0) {
            return waitEvaluation(currentCandle.closeTime);
          }
          const evaluation = executeEvaluation(
            OrderSide.BUY,
            currentCandle.closeTime,
            100,
            99,
            110,
          );
          if (!evaluation.plan) throw new Error("Plan missing.");
          evaluation.plan.management.moveStopToBreakEvenAtR = 100;
          evaluation.plan.management.trailingStop = {
            enabled: true,
            startAtR: 1,
            mode: "ATR",
            atrMultiple: 0.5,
            neverWidenStop: true,
          };
          return evaluation;
        },
      },
      config: {
        warmupBars: 0,
        contractSize: 100,
        fallbackSpread: 0,
        trailingAtrPeriod: 2,
      },
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.exitReason).toBe("STOP_LOSS");
    expect(result.trades[0]!.averageExitPrice).toBeGreaterThan(100);
    expect(result.trades[0]!.netPnl).toBeGreaterThan(0);
  });
});
