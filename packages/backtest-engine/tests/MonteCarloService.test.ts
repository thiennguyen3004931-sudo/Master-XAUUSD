import { describe, expect, it } from "vitest";
import { OrderSide } from "@xauusd/types";
import {
  MonteCarloService,
  type BacktestTrade,
} from "../src";

describe("MonteCarloService", () => {
  it("is deterministic for the same seed", () => {
    const trades: BacktestTrade[] = [100, -50, 80, -20].map(
      (netPnl, index) => ({
        id: String(index),
        symbol: "XAUUSD",
        side: OrderSide.BUY,
        strategyId: "A",
        entryTime: index,
        exitTime: index + 1,
        entryPrice: 100,
        averageExitPrice: 100,
        initialVolume: 1,
        grossPnl: netPnl,
        commission: 0,
        netPnl,
        rMultiple: netPnl / 50,
        durationMinutes: 1,
        exitReason:
          netPnl >= 0 ? "TAKE_PROFIT" : "STOP_LOSS",
        partialExits: [],
      }),
    );

    const service = new MonteCarloService();
    const first = service.run(trades, 10_000, {
      iterations: 100,
      seed: 42,
      confidenceLevel: 0.95,
    });
    const second = service.run(trades, 10_000, {
      iterations: 100,
      seed: 42,
      confidenceLevel: 0.95,
    });

    expect(first.endingBalanceMedian).toBe(
      second.endingBalanceMedian,
    );
    expect(first.paths).toEqual(second.paths);
  });
});
