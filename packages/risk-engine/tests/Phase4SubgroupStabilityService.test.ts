import { describe, expect, it } from "vitest";
import { Phase4SubgroupStabilityService } from "../src";
import type { Phase4ShadowTradeCase } from "../src";

const makeCase = (
  id: string,
  side: "BUY" | "SELL",
  entrySource: "CANONICAL" | "VOLUME_PROFILE",
  signalTimestamp: number,
): Phase4ShadowTradeCase => ({
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
      high: side === "BUY" ? 3407 : 3401,
      low: side === "BUY" ? 3399 : 3393,
      close: side === "BUY" ? 3406 : 3394,
      volume: 100,
    },
  ],
});

describe("Phase4SubgroupStabilityService", () => {
  it("keeps the four contribution groups separate across common chronological folds", () => {
    const cases: Phase4ShadowTradeCase[] = [];
    for (let fold = 0; fold < 5; fold += 1) {
      const base = 1_000 + fold * 1_000_000;
      cases.push(makeCase(`cb-${fold}`, "BUY", "CANONICAL", base));
      cases.push(makeCase(`cs-${fold}`, "SELL", "CANONICAL", base + 100_000));
      cases.push(makeCase(`rb-${fold}`, "BUY", "VOLUME_PROFILE", base + 200_000));
      cases.push(makeCase(`rs-${fold}`, "SELL", "VOLUME_PROFILE", base + 300_000));
    }

    const service = new Phase4SubgroupStabilityService();
    const result = service.run(cases);
    const byLabel = new Map(result.groups.map((item) => [item.label, item]));

    expect(result.foldCount).toBe(5);
    expect(byLabel.get("CANONICAL_BUY")?.cases).toBe(5);
    expect(byLabel.get("CANONICAL_SELL")?.cases).toBe(5);
    expect(byLabel.get("RESCUED_BUY")?.cases).toBe(5);
    expect(byLabel.get("RESCUED_SELL")?.cases).toBe(5);
    expect(byLabel.get("CANONICAL_SELL")?.activeFolds).toBe(5);
    expect(service.format(result)).toContain("PHASE4H_RESEARCH_ONLY=PASS");
    expect(service.format(result)).toContain("PHASE4H_PRODUCTION_MUTATION=false");
  });

  it("rejects invalid fold counts", () => {
    const service = new Phase4SubgroupStabilityService();
    expect(() => service.run([
      makeCase("one", "BUY", "CANONICAL", 1_000),
    ], undefined, 2)).toThrow(/at least 3 folds/);
  });
});
