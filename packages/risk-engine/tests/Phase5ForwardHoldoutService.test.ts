import { describe, expect, it } from "vitest";
import {
  PHASE5_FORWARD_CUTOFF_TIMESTAMP,
  PHASE5_FORWARD_DATASET_CUTOFF_TIMESTAMP,
  PHASE5_FORWARD_DATASET_OFFSET_MS,
  Phase5ForwardHoldoutService,
  type Phase4ShadowTradeCase,
} from "../src";

function makeCase(
  id: string,
  signalTimestamp: number,
  side: "BUY" | "SELL" = "SELL",
  entrySource: "CANONICAL" | "VOLUME_PROFILE" = "CANONICAL",
): Phase4ShadowTradeCase {
  const sell = side === "SELL";
  return {
    id,
    side,
    signalTimestamp,
    entryExpiresAt: signalTimestamp + 300_000,
    entry: 3400,
    stopLoss: sell ? 3405 : 3395,
    takeProfit: sell ? 3380 : 3420,
    volume: 0.01,
    tickSize: 0.01,
    tickValuePerLot: 1,
    entrySource,
    m5Bars: [
      {
        openTime: signalTimestamp,
        closeTime: signalTimestamp + 300_000,
        open: 3400,
        high: sell ? 3401 : 3410,
        low: sell ? 3390 : 3399,
        close: sell ? 3390 : 3410,
        volume: 100,
      },
    ],
  };
}

describe("Phase5ForwardHoldoutService", () => {
  it("locks the real cutoff and broker +03:00 dataset-time mapping", () => {
    expect(new Date(PHASE5_FORWARD_CUTOFF_TIMESTAMP).toISOString()).toBe(
      "2026-08-12T12:45:00.000Z",
    );
    expect(PHASE5_FORWARD_DATASET_OFFSET_MS).toBe(10_800_000);
    expect(new Date(PHASE5_FORWARD_DATASET_CUTOFF_TIMESTAMP).toISOString()).toBe(
      "2026-08-12T15:45:00.000Z",
    );
  });

  it("uses only post-cutoff canonical SELL cases and can pass after the sample gate", () => {
    const service = new Phase5ForwardHoldoutService();
    const result = service.run(
      [
        makeCase("old-sell", 900),
        makeCase("new-sell-1", 2_000),
        makeCase("new-sell-2", 3_000),
        makeCase("new-buy", 4_000, "BUY"),
        makeCase("rescued-sell", 5_000, "SELL", "VOLUME_PROFILE"),
      ],
      1_000,
      undefined,
      2,
    );

    expect(result.preCutoffCasesIgnored).toBe(1);
    expect(result.postCutoffCases).toBe(4);
    expect(result.eligibleCases).toBe(2);
    expect(result.metrics.filledTrades).toBe(2);
    expect(result.status).toBe("PASS");
    expect(service.format(result)).toContain("PHASE5_PRE_REGISTERED=PASS");
  });

  it("does not declare pass or fail before the pre-registered sample gate", () => {
    const service = new Phase5ForwardHoldoutService();
    const result = service.run([makeCase("new-sell", 2_000)], 1_000, undefined, 30);

    expect(result.metrics.filledTrades).toBe(1);
    expect(result.status).toBe("INSUFFICIENT_SAMPLE");
  });
});
