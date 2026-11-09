import { describe, expect, it } from "vitest";
import { Phase4ShadowReplayService } from "../src";

const bar = (
  openTime: number,
  open: number,
  high: number,
  low: number,
  close: number,
) => ({ openTime, closeTime: openTime + 300_000, open, high, low, close, volume: 100 });

describe("Phase4ShadowReplayService", () => {
  it("fills on touch and uses STOP_FIRST when SL and TP share a bar", () => {
    const service = new Phase4ShadowReplayService();
    const result = service.run([{
      id: "buy-stop-first",
      side: "BUY",
      signalTimestamp: 1_000,
      entryExpiresAt: 1_000 + 900_000,
      entry: 3400,
      stopLoss: 3395,
      takeProfit: 3405,
      volume: 0.01,
      tickSize: 0.01,
      tickValuePerLot: 1,
      m5Bars: [bar(1_000, 3400, 3406, 3394, 3401)],
    }]);

    expect(result.metrics.filledTrades).toBe(1);
    expect(result.trades[0]?.exitReason).toBe("STOP");
    expect(result.trades[0]?.pnl).toBe(-5);
  });

  it("applies break-even after +6 and trailing after +10 only on following bars", () => {
    const service = new Phase4ShadowReplayService();
    const result = service.run([{
      id: "buy-management",
      side: "BUY",
      signalTimestamp: 1_000,
      entryExpiresAt: 1_000 + 900_000,
      entry: 3400,
      stopLoss: 3390,
      takeProfit: 3430,
      volume: 0.01,
      tickSize: 0.01,
      tickValuePerLot: 1,
      m5Bars: [
        bar(1_000, 3400, 3407, 3399, 3406),
        bar(301_000, 3406, 3411, 3405, 3410),
        bar(601_000, 3409, 3410, 3406.5, 3407),
        bar(901_000, 3407, 3408, 3406.8, 3407.2),
      ],
    }]);

    const trade = result.trades[0]!;
    expect(trade.reachedPlus6).toBe(true);
    expect(trade.reachedPlus10).toBe(true);
    expect(trade.breakEvenApplied).toBe(true);
    expect(trade.trailingActivated).toBe(true);
    expect(trade.exitReason).toBe("STOP");
    expect(trade.pnl).toBeGreaterThan(0);
  });

  it("keeps untouched planned entries unfilled", () => {
    const service = new Phase4ShadowReplayService();
    const result = service.run([{
      id: "sell-unfilled",
      side: "SELL",
      signalTimestamp: 1_000,
      entryExpiresAt: 601_000,
      entry: 3410,
      stopLoss: 3415,
      takeProfit: 3400,
      volume: 0.01,
      tickSize: 0.01,
      tickValuePerLot: 1,
      m5Bars: [bar(1_000, 3400, 3405, 3398, 3402)],
    }]);

    expect(result.metrics.filledTrades).toBe(0);
    expect(result.metrics.unfilledTrades).toBe(1);
    expect(result.trades[0]?.exitReason).toBe("ENTRY_NOT_FILLED");
  });
});
