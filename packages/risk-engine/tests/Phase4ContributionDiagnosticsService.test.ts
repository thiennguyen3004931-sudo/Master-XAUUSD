import { describe, expect, it } from "vitest";
import { Phase4ContributionDiagnosticsService } from "../src";
import type { Phase4ShadowTradeCase } from "../src";

const makeCase = (
  id: string,
  side: "BUY" | "SELL",
  entrySource: "CANONICAL" | "VOLUME_PROFILE",
): Phase4ShadowTradeCase => ({
  id,
  side,
  signalTimestamp: 1_000,
  entryExpiresAt: 301_000,
  entry: 3400,
  stopLoss: side === "BUY" ? 3395 : 3405,
  takeProfit: side === "BUY" ? 3420 : 3380,
  volume: 0.01,
  tickSize: 0.01,
  tickValuePerLot: 1,
  entrySource,
  m5Bars: [
    {
      openTime: 1_000,
      closeTime: 301_000,
      open: 3400,
      high: 3407,
      low: 3399,
      close: side === "BUY" ? 3406 : 3394,
      volume: 100,
    },
  ],
});

describe("Phase4ContributionDiagnosticsService", () => {
  it("splits canonical/rescued and BUY/SELL contribution slices", () => {
    const service = new Phase4ContributionDiagnosticsService();
    const result = service.run([
      makeCase("c-buy", "BUY", "CANONICAL"),
      makeCase("c-sell", "SELL", "CANONICAL"),
      makeCase("r-buy", "BUY", "VOLUME_PROFILE"),
      makeCase("r-sell", "SELL", "VOLUME_PROFILE"),
    ]);

    const byLabel = new Map(result.slices.map((item) => [item.label, item]));
    expect(byLabel.get("ALL")?.cases).toBe(4);
    expect(byLabel.get("CANONICAL")?.cases).toBe(2);
    expect(byLabel.get("RESCUED")?.cases).toBe(2);
    expect(byLabel.get("CANONICAL_BUY")?.cases).toBe(1);
    expect(byLabel.get("RESCUED_SELL")?.cases).toBe(1);
    expect(service.format(result)).toContain("PHASE4G_RESEARCH_ONLY=PASS");
  });
});
