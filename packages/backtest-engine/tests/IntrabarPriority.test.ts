import { describe, expect, it } from "vitest";
import { OrderSide } from "@xauusd/types";
import { BacktestEngine } from "../src";
import {
  createCandles,
  executeEvaluation,
  waitEvaluation,
} from "./fixtures";

async function run(priority: "STOP_FIRST" | "TARGET_FIRST") {
  const candles = createCandles([100, 100, 100, 100]);
  candles[2] = {
    ...candles[2]!,
    open: 100,
    high: 103,
    low: 98,
    close: 100,
  };

  return new BacktestEngine().run({
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
      fallbackSpread: 0,
      intrabarPriority: priority,
    },
  });
}

describe("intrabar ambiguity policy", () => {
  it("uses the conservative stop-first policy", async () => {
    const result = await run("STOP_FIRST");
    expect(result.trades[0]!.netPnl).toBe(-100);
    expect(result.trades[0]!.exitReason).toBe("STOP_LOSS");
  });

  it("supports target-first sensitivity analysis", async () => {
    const result = await run("TARGET_FIRST");
    expect(result.trades[0]!.netPnl).toBe(200);
    expect(result.trades[0]!.exitReason).toBe("TAKE_PROFIT");
  });
});
