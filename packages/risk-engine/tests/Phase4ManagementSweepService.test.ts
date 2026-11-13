import { describe, expect, it } from "vitest";
import { Phase4ManagementSweepService } from "../src";

const bar = (
  openTime: number,
  open: number,
  high: number,
  low: number,
  close: number,
) => ({ openTime, closeTime: openTime + 300_000, open, high, low, close, volume: 100 });

const cases = [{
  id: "sweep-case",
  side: "BUY" as const,
  signalTimestamp: 1_000,
  entryExpiresAt: 901_000,
  entry: 3400,
  stopLoss: 3390,
  takeProfit: 3430,
  volume: 0.01,
  tickSize: 0.01,
  tickValuePerLot: 1,
  m5Bars: [
    bar(1_000, 3400, 3407, 3399, 3406),
    bar(301_000, 3406, 3412, 3405, 3410),
    bar(601_000, 3410, 3414, 3408, 3412),
  ],
}];

describe("Phase4ManagementSweepService", () => {
  it("evaluates and ranks multiple research-only management variants", () => {
    const service = new Phase4ManagementSweepService();
    const result = service.run(cases, [
      {
        breakEvenTriggerPrice: 6,
        breakEvenOffsetPrice: 0.1,
        trailingTriggerPrice: 10,
        trailingDistancePrice: 4,
      },
      {
        breakEvenTriggerPrice: 8,
        breakEvenOffsetPrice: 1,
        trailingTriggerPrice: 12,
        trailingDistancePrice: 6,
      },
    ]);

    expect(result.variants).toHaveLength(2);
    expect(result.bestByExpectancy).not.toBeNull();
    expect(result.bestByProfitFactor).not.toBeNull();
    expect(result.bestByNetPnl).not.toBeNull();
    expect(service.format(result)).toContain("PHASE4D_VARIANTS=2");
    expect(service.format(result)).toContain("PHASE4D_RESEARCH_ONLY=PASS");
  });
});
