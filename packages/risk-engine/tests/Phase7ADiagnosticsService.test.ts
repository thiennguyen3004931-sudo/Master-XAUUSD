import { describe, expect, it } from "vitest";
import {
  Phase7ADiagnosticsService,
  type Phase7RunRequest,
  type Phase7RunResult,
  type Phase7TradeResult,
} from "../src";

function trade(overrides: Partial<Phase7TradeResult>): Phase7TradeResult {
  return {
    id: "t1",
    side: "BUY",
    signalTimestamp: 1_000,
    entry: 100,
    engulfingExtreme: 98,
    structuralStopDistance: 2,
    stopDistance: 6,
    stopLoss: 94,
    volume: 0.03,
    initialRiskUsd: 18,
    ma20: 99,
    ma50: 98,
    ma200: 95,
    fvg: true,
    filled: true,
    entryTime: 1_000,
    exitTime: 2_000,
    exit: 105,
    finalStopLoss: 105,
    pnl: 21,
    rMultiple: 1.1667,
    holdHours: 0.25,
    partial1Applied: true,
    partial1Volume: 0.01,
    partial1Pnl: 6,
    protectedStopApplied: true,
    partial2Applied: true,
    partial2Volume: 0.01,
    partial2Pnl: 10,
    trailingActivated: true,
    remainingVolumeAtExit: 0.01,
    exitReason: "STOP",
    ...overrides,
  };
}

const request: Phase7RunRequest = {
  m15Bars: [],
  m5Bars: [
    { openTime: 1_000, closeTime: 1_500, open: 100, high: 111, low: 99, close: 108 },
    { openTime: 1_500, closeTime: 2_000, open: 108, high: 109, low: 105, close: 105 },
  ],
  fixedVolume: 0.03,
  tickSize: 0.01,
  tickValuePerLot: 1,
  minVolume: 0.01,
  volumeStep: 0.01,
};

function result(trades: Phase7TradeResult[]): Phase7RunResult {
  return {
    config: {
      fvgLookbackBars: 12,
      entryExpiryMinutes: 15,
      minStopDistancePrice: 6,
      maxStopDistancePrice: 10,
      partial1TriggerPrice: 6,
      partial1Fraction: 1 / 3,
      protectedProfitOffsetPrice: 2,
      partial2TriggerPrice: 10,
      partial2Fraction: 1 / 3,
      trailingDistancePrice: 5,
    },
    metrics: {
      m15Bars: 0,
      engulfingTriggers: trades.length,
      trendAligned: trades.length,
      fvgConfirmed: trades.length,
      stopFlooredToMin: 1,
      stopCappedToMax: 1,
      signals: trades.length,
      buySignals: trades.filter((t) => t.side === "BUY").length,
      sellSignals: trades.filter((t) => t.side === "SELL").length,
      filledTrades: trades.filter((t) => t.filled).length,
      unfilledTrades: trades.filter((t) => !t.filled).length,
      wins: trades.filter((t) => t.pnl > 0).length,
      losses: trades.filter((t) => t.pnl < 0).length,
      flat: trades.filter((t) => t.pnl === 0).length,
      winRatePercent: 0,
      netPnl: trades.reduce((sum, t) => sum + t.pnl, 0),
      grossProfit: 0,
      grossLoss: 0,
      profitFactor: null,
      expectancy: 0,
      averageRMultiple: 0,
      maxRealizedDrawdownUsd: 0,
      averageHoldHours: 0,
      partial1Applied: 1,
      protectedStopApplied: 1,
      partial2Applied: 1,
      trailingActivated: 1,
    },
    signals: trades,
    trades,
  };
}

describe("Phase7ADiagnosticsService", () => {
  it("classifies floor/cap stops and measures partial-close counterfactual without mutating Phase 7", () => {
    const buy = trade({ id: "buy-floor" });
    const sell = trade({
      id: "sell-cap",
      side: "SELL",
      entry: 100,
      engulfingExtreme: 113,
      structuralStopDistance: 13,
      stopDistance: 10,
      stopLoss: 110,
      volume: 0.03,
      initialRiskUsd: 30,
      ma20: 101,
      ma50: 102,
      ma200: 105,
      partial1Applied: false,
      partial1Volume: 0,
      partial1Pnl: 0,
      protectedStopApplied: false,
      partial2Applied: false,
      partial2Volume: 0,
      partial2Pnl: 0,
      trailingActivated: false,
      remainingVolumeAtExit: 0.03,
      exit: 110,
      finalStopLoss: 110,
      pnl: -30,
      rMultiple: -1,
    });
    const phase7 = result([buy, sell]);
    const original = JSON.stringify(phase7);
    const diagnostics = new Phase7ADiagnosticsService().analyze(phase7, request, 0);

    expect(diagnostics.rows[0]!.stopBucket).toBe("FLOOR_6");
    expect(diagnostics.rows[0]!.managementStage).toBe("PLUS10_TRAIL");
    expect(diagnostics.rows[0]!.partialVsFullSameExitPnlDelta).toBe(6);
    expect(diagnostics.rows[1]!.stopBucket).toBe("CAP_10");
    expect(diagnostics.rows[1]!.managementStage).toBe("PRE_PLUS6");
    expect(diagnostics.lines).toContain("PHASE7A_STRATEGY_MUTATION=false");
    expect(diagnostics.lines).toContain("PHASE7A_NO_RETUNE=PASS");
    expect(JSON.stringify(phase7)).toBe(original);
  });
});
