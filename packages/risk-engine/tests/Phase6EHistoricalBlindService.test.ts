import { describe, expect, it } from "vitest";
import {
  PHASE6E_BASELINE_CONFIG,
  Phase6EHistoricalBlindService,
  type Phase6Bar,
  type Phase6RunResult,
  type Phase6TradeResult,
} from "../src";

function trade(
  id: string,
  side: "BUY" | "SELL",
  timestamp: number,
  pnl: number,
): Phase6TradeResult {
  return {
    id,
    side,
    signalTimestamp: timestamp,
    entry: 100,
    stopLoss: side === "BUY" ? 99 : 101,
    volume: 0.01,
    initialRiskUsd: 1,
    ma20: 100,
    ma50: 99,
    ma200: 98,
    atr: 2,
    confluenceScore: 2,
    maPullback: true,
    fvg: false,
    volumeProfile: true,
    profile: null,
    filled: true,
    entryTime: timestamp,
    exitTime: timestamp + 1_000,
    exit: side === "BUY" ? 101 : 99,
    finalStopLoss: side === "BUY" ? 99 : 101,
    pnl,
    rMultiple: pnl,
    holdHours: 0.1,
    reachedPlus6: false,
    reachedPlus10: false,
    breakEvenApplied: false,
    trailingActivated: false,
    exitReason: "END_OF_DATA",
  };
}

function baseline(trades: Phase6TradeResult[]): Phase6RunResult {
  return {
    config: { ...PHASE6E_BASELINE_CONFIG },
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

function bar(openTime: number, high: number, low: number): Phase6Bar {
  return {
    openTime,
    closeTime: openTime + 500,
    open: 100,
    high,
    low,
    close: 100,
    volume: 1,
  };
}

describe("Phase6EHistoricalBlindService", () => {
  it("keeps only the fixed blind window, accepts BUY and SELL, and computes diagnostic excursions", () => {
    const blindStart = 1_000;
    const blindEnd = 10_000;
    const buy = trade("buy", "BUY", 2_000, 2);
    const sell = trade("sell", "SELL", 8_000, 1);
    const result = new Phase6EHistoricalBlindService().run(
      baseline([
        trade("before", "BUY", 999, 5),
        buy,
        sell,
        trade("at-end", "SELL", blindEnd, 5),
      ]),
      [
        bar(2_000, 104, 99.5),
        bar(8_000, 100.5, 96),
      ],
      blindStart,
      blindEnd,
    );

    expect(result.candidate).toBe("BASELINE_BUY_SELL");
    expect(result.eligibleCases).toBe(2);
    expect(result.eligibleBuyCases).toBe(1);
    expect(result.eligibleSellCases).toBe(1);
    expect(result.folds).toHaveLength(6);
    expect(result.status).toBe("INSUFFICIENT_SAMPLE");

    const buyExcursion = result.excursions.find((item) => item.id === "buy");
    const sellExcursion = result.excursions.find((item) => item.id === "sell");
    expect(buyExcursion?.mfePrice).toBe(4);
    expect(buyExcursion?.maePrice).toBe(0.5);
    expect(buyExcursion?.mfeR).toBe(4);
    expect(sellExcursion?.mfePrice).toBe(4);
    expect(sellExcursion?.maePrice).toBe(0.5);
  });

  it("rejects baseline configuration drift", () => {
    const bad = baseline([]);
    bad.config = { ...bad.config, trailingDistancePrice: 4 };
    expect(() => new Phase6EHistoricalBlindService().run(bad, [], 1_000, 2_000))
      .toThrow(/config drift/);
  });
});
