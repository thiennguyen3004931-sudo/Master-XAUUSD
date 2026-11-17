import { describe, expect, it } from "vitest";
import { Phase4WalkForwardService, phase4eConfigs } from "../src";
import type { Phase4ShadowTradeCase } from "../src";

const bar = (openTime: number, high: number, low: number, close: number) => ({
  openTime,
  closeTime: openTime + 300_000,
  open: close,
  high,
  low,
  close,
  volume: 100,
});

function makeCase(index: number): Phase4ShadowTradeCase {
  const signalTimestamp = 1_000 + index * 1_000_000;
  const entry = 3400;
  return {
    id: `case-${index}`,
    side: "BUY",
    signalTimestamp,
    entryExpiresAt: signalTimestamp + 300_000,
    entry,
    stopLoss: 3395,
    takeProfit: 3425,
    volume: 0.01,
    tickSize: 0.01,
    tickValuePerLot: 1,
    m5Bars: [
      bar(signalTimestamp, 3407, 3399, 3406),
      bar(signalTimestamp + 300_000, 3411, 3405, 3410),
      bar(signalTimestamp + 600_000, 3413, 3406, 3409),
    ],
  };
}

describe("Phase4WalkForwardService", () => {
  it("runs five chronological folds and reports OOS/robustness metrics", () => {
    const service = new Phase4WalkForwardService();
    const result = service.run(
      Array.from({ length: 20 }, (_, index) => makeCase(index)),
    );

    expect(result.folds).toBe(5);
    expect(result.walkForward).toHaveLength(4);
    expect(result.configs).toBe(18);
    expect(result.oosMetrics.filledTrades).toBeGreaterThan(0);
    expect(result.robustConfigs.length).toBeGreaterThanOrEqual(0);
    const lines = service.format(result);
    expect(lines).toContain("PHASE4E_RESEARCH_ONLY=PASS");
    expect(lines).toContain("PHASE4E_PRODUCTION_MUTATION=false");
  });

  it("exposes the intended +6 robustness neighborhood", () => {
    const configs = phase4eConfigs();
    expect(configs).toHaveLength(18);
    expect(configs.every((item) => item.breakEvenTriggerPrice === 6)).toBe(true);
    expect(new Set(configs.map((item) => item.breakEvenOffsetPrice))).toEqual(
      new Set([1, 1.5, 2]),
    );
    expect(new Set(configs.map((item) => item.trailingDistancePrice))).toEqual(
      new Set([5, 6, 7]),
    );
  });
});
