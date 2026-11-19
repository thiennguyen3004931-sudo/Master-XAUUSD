import { describe, expect, it } from "vitest";
import { Phase4ShadowDiagnosticsService } from "../src";
import type { Phase4ShadowTradeCase } from "../src";

function makeCase(
  id: string,
  signalTimestamp: number,
  side: "BUY" | "SELL",
  entrySource: Phase4ShadowTradeCase["entrySource"],
): Phase4ShadowTradeCase {
  return {
    id,
    side,
    signalTimestamp,
    entryExpiresAt: signalTimestamp + 300_000,
    entry: 3400,
    stopLoss: side === "BUY" ? 3395 : 3405,
    takeProfit: side === "BUY" ? 3420 : 3380,
    volume: 0.01,
    tickSize: 0.01,
    tickValuePerLot: 1,
    entrySource,
    m5Bars: [
      {
        openTime: signalTimestamp,
        closeTime: signalTimestamp + 300_000,
        open: 3400,
        high: 3408,
        low: 3398,
        close: side === "BUY" ? 3407 : 3399,
        volume: 100,
      },
    ],
  };
}

describe("Phase4ShadowDiagnosticsService", () => {
  it("reports duplicate ids, canonical/rescued split, and folds", () => {
    const cases = [
      makeCase("a", 1_000, "BUY", "CANONICAL"),
      makeCase("b", 2_000, "SELL", "FVG"),
      makeCase("b", 3_000, "SELL", "FVG"),
      makeCase("c", 4_000, "BUY", "MA20"),
      makeCase("d", 5_000, "BUY", "CANONICAL"),
    ];

    const service = new Phase4ShadowDiagnosticsService();
    const result = service.run(cases, undefined, 5);

    expect(result.totalCases).toBe(5);
    expect(result.uniqueCaseIds).toBe(4);
    expect(result.duplicateCaseIds).toEqual(["b"]);
    expect(result.canonicalCases).toBe(2);
    expect(result.rescuedCases).toBe(3);
    expect(result.folds).toHaveLength(5);
    expect(service.format(result)).toContain("PHASE4F_DUPLICATE_CASE_IDS=1");
  });
});
