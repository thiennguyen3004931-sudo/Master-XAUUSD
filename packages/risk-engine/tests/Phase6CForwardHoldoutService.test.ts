import { describe, expect, it } from "vitest";
import {
  PHASE6C_BASELINE_CONFIG,
  PHASE6C_FORWARD_CUTOFF_TIMESTAMP,
  PHASE6C_FORWARD_DATASET_CUTOFF_TIMESTAMP,
  Phase6CForwardHoldoutService,
  type Phase6RunResult,
  type Phase6TradeResult,
} from "../src";

function trade(
  id: string,
  side: "BUY" | "SELL",
  signalTimestamp: number,
  pnl: number,
): Phase6TradeResult {
  return {
    id,
    side,
    signalTimestamp,
    entry: 2500,
    stopLoss: side === "BUY" ? 2495 : 2505,
    volume: 0.01,
    initialRiskUsd: 5,
    ma20: 2500,
    ma50: side === "BUY" ? 2490 : 2510,
    ma200: side === "BUY" ? 2480 : 2520,
    atr: 5,
    confluenceScore: 2,
    maPullback: true,
    fvg: true,
    volumeProfile: false,
    profile: null,
    filled: true,
    entryTime: signalTimestamp,
    exitTime: signalTimestamp + 5 * 60_000,
    exit: side === "BUY" ? 2501 : 2499,
    finalStopLoss: side === "BUY" ? 2495 : 2505,
    pnl,
    rMultiple: pnl / 5,
    holdHours: 0.08,
    reachedPlus6: false,
    reachedPlus10: false,
    breakEvenApplied: false,
    trailingActivated: false,
    exitReason: pnl >= 0 ? "TREND_MA20" : "STOP",
  };
}

function baseline(trades: Phase6TradeResult[]): Phase6RunResult {
  return {
    config: { ...PHASE6C_BASELINE_CONFIG },
    metrics: {} as Phase6RunResult["metrics"],
    signals: [],
    trades,
  };
}

describe("Phase6CForwardHoldoutService", () => {
  it("locks the real cutoff and +03 dataset coordinate", () => {
    expect(new Date(PHASE6C_FORWARD_CUTOFF_TIMESTAMP).toISOString())
      .toBe("2026-08-12T16:10:00.000Z");
    expect(new Date(PHASE6C_FORWARD_DATASET_CUTOFF_TIMESTAMP).toISOString())
      .toBe("2026-08-12T19:10:00.000Z");
  });

  it("counts only post-cutoff baseline BUY trades and waits for 30 fills", () => {
    const cutoff = PHASE6C_FORWARD_DATASET_CUTOFF_TIMESTAMP;
    const result = new Phase6CForwardHoldoutService().run(baseline([
      trade("pre-buy", "BUY", cutoff - 1, 5),
      trade("post-sell", "SELL", cutoff + 1, 5),
      trade("post-buy", "BUY", cutoff + 2, 5),
    ]));

    expect(result.preCutoffCasesIgnored).toBe(1);
    expect(result.postCutoffCases).toBe(2);
    expect(result.eligibleCases).toBe(1);
    expect(result.metrics.filledTrades).toBe(1);
    expect(result.metrics.netPnl).toBe(5);
    expect(result.status).toBe("INSUFFICIENT_SAMPLE");
  });

  it("passes at 30 fills only when the pre-registered positive gates pass", () => {
    const cutoff = PHASE6C_FORWARD_DATASET_CUTOFF_TIMESTAMP;
    const trades = Array.from({ length: 30 }, (_, index) =>
      trade(`buy-${index}`, "BUY", cutoff + (index + 1) * 60_000, 5),
    );
    const result = new Phase6CForwardHoldoutService().run(baseline(trades));

    expect(result.metrics.filledTrades).toBe(30);
    expect(result.metrics.netPnl).toBeGreaterThan(0);
    expect(result.metrics.expectancy).toBeGreaterThan(0);
    expect(result.metrics.averageRMultiple).toBeGreaterThan(0);
    expect(result.status).toBe("PASS");
  });

  it("fails after 30 fills when the forward edge is non-positive", () => {
    const cutoff = PHASE6C_FORWARD_DATASET_CUTOFF_TIMESTAMP;
    const trades = Array.from({ length: 30 }, (_, index) =>
      trade(`buy-${index}`, "BUY", cutoff + (index + 1) * 60_000, -5),
    );
    const result = new Phase6CForwardHoldoutService().run(baseline(trades));
    expect(result.status).toBe("FAIL");
  });

  it("rejects baseline configuration drift", () => {
    const changed = baseline([]);
    changed.config = { ...changed.config, minConfluenceScore: 1 };
    expect(() => new Phase6CForwardHoldoutService().run(changed))
      .toThrow(/config drift/i);
  });
});
