import { describe, expect, it } from "vitest";
import {
  PHASE6D_BASELINE_CONFIG,
  PHASE6D_FORWARD_DATASET_CUTOFF_TIMESTAMP,
  Phase6DForwardHoldoutService,
  type Phase6RunResult,
  type Phase6TradeResult,
} from "../src";

function trade(id: string, side: "BUY" | "SELL", timestamp: number, pnl: number): Phase6TradeResult {
  return {
    id,
    side,
    signalTimestamp: timestamp,
    entry: 100,
    stopLoss: side === "BUY" ? 99 : 101,
    volume: 0.01,
    initialRiskUsd: 1,
    ma20: 100,
    ma50: 100,
    ma200: 100,
    atr: 1,
    confluenceScore: 2,
    maPullback: true,
    fvg: true,
    volumeProfile: false,
    profile: null,
    filled: true,
    entryTime: timestamp,
    exitTime: timestamp + 300_000,
    exit: side === "BUY" ? 101 : 99,
    finalStopLoss: side === "BUY" ? 99 : 101,
    pnl,
    rMultiple: pnl,
    holdHours: 0.08,
    reachedPlus6: false,
    reachedPlus10: false,
    breakEvenApplied: false,
    trailingActivated: false,
    exitReason: "END_OF_DATA",
  };
}

function baseline(trades: Phase6TradeResult[]): Phase6RunResult {
  return {
    config: { ...PHASE6D_BASELINE_CONFIG },
    metrics: {
      m15Bars: 0,
      engulfingTriggers: 0,
      trendAligned: 0,
      confluencePassed: 0,
      riskBlocked: 0,
      signals: trades.length,
      buySignals: trades.filter((item) => item.side === "BUY").length,
      sellSignals: trades.filter((item) => item.side === "SELL").length,
      filledTrades: trades.length,
      unfilledTrades: 0,
      wins: trades.filter((item) => item.pnl > 0).length,
      losses: trades.filter((item) => item.pnl < 0).length,
      flat: trades.filter((item) => item.pnl === 0).length,
      winRatePercent: 0,
      netPnl: 0,
      grossProfit: 0,
      grossLoss: 0,
      profitFactor: null,
      expectancy: 0,
      averageRMultiple: 0,
      maxRealizedDrawdownUsd: 0,
      averageHoldHours: 0,
      reachedPlus6: 0,
      reachedPlus10: 0,
      breakEvenApplied: 0,
      trailingActivated: 0,
    },
    signals: trades,
    trades,
  };
}

describe("Phase6DForwardHoldoutService", () => {
  it("accepts both BUY and SELL after the locked cutoff", () => {
    const cutoff = PHASE6D_FORWARD_DATASET_CUTOFF_TIMESTAMP;
    const result = new Phase6DForwardHoldoutService().run(baseline([
      trade("old-buy", "BUY", cutoff - 1, 1),
      trade("new-buy", "BUY", cutoff + 1, 2),
      trade("new-sell", "SELL", cutoff + 2, 3),
    ]));

    expect(result.candidate).toBe("BASELINE_BUY_SELL");
    expect(result.preCutoffCasesIgnored).toBe(1);
    expect(result.eligibleCases).toBe(2);
    expect(result.eligibleBuyCases).toBe(1);
    expect(result.eligibleSellCases).toBe(1);
    expect(result.metrics.filledTrades).toBe(2);
    expect(result.status).toBe("INSUFFICIENT_SAMPLE");
  });

  it("rejects baseline configuration drift", () => {
    const bad = baseline([]);
    bad.config = { ...bad.config, minConfluenceScore: 1 };
    expect(() => new Phase6DForwardHoldoutService().run(bad)).toThrow(/config drift/);
  });
});
