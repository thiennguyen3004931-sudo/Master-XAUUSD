import { describe, expect, it } from "vitest";
import {
  DrawdownService,
  MetricsService,
  defaultBacktestConfig,
  type BacktestTrade,
  type EquityPoint,
} from "../src";
import { OrderSide } from "@xauusd/types";

describe("MetricsService", () => {
  it("calculates win rate, profit factor and drawdown", () => {
    const trades: BacktestTrade[] = [
      {
        id: "1",
        symbol: "XAUUSD",
        side: OrderSide.BUY,
        strategyId: "A",
        entryTime: 0,
        exitTime: 60_000,
        entryPrice: 100,
        averageExitPrice: 102,
        initialVolume: 1,
        grossPnl: 200,
        commission: 0,
        netPnl: 200,
        rMultiple: 2,
        durationMinutes: 1,
        exitReason: "TAKE_PROFIT",
        partialExits: [],
      },
      {
        id: "2",
        symbol: "XAUUSD",
        side: OrderSide.BUY,
        strategyId: "A",
        entryTime: 60_000,
        exitTime: 120_000,
        entryPrice: 100,
        averageExitPrice: 99,
        initialVolume: 1,
        grossPnl: -100,
        commission: 0,
        netPnl: -100,
        rMultiple: -1,
        durationMinutes: 1,
        exitReason: "STOP_LOSS",
        partialExits: [],
      },
    ];
    const equity: EquityPoint[] = [
      {
        timestamp: 0,
        balance: 10_000,
        equity: 10_000,
        unrealizedPnl: 0,
      },
      {
        timestamp: 60_000,
        balance: 10_200,
        equity: 10_200,
        unrealizedPnl: 0,
      },
      {
        timestamp: 120_000,
        balance: 10_100,
        equity: 10_100,
        unrealizedPnl: 0,
      },
    ];
    const drawdown = new DrawdownService().calculate(equity);
    const metrics = new MetricsService().calculate(
      trades,
      equity,
      drawdown,
      defaultBacktestConfig,
      0,
      120_000,
    );

    expect(metrics.winRatePercent).toBe(50);
    expect(metrics.profitFactor).toBe(2);
    expect(metrics.maxDrawdownAmount).toBe(100);
  });
});
