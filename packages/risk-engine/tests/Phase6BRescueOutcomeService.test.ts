import { describe, expect, it } from "vitest";
import {
  Phase6BRescueOutcomeService,
  type Phase6ADiagnosticMetrics,
  type Phase6ADiagnosticsResult,
  type Phase6Bar,
  type Phase6RunRequest,
  type Phase6RunResult,
} from "../src";

const M15 = 15 * 60_000;
const M5 = 5 * 60_000;

function zeroMetrics(): Phase6ADiagnosticMetrics {
  return {
    cases: 0,
    filledTrades: 0,
    wins: 0,
    losses: 0,
    flat: 0,
    winRatePercent: 0,
    netPnl: 0,
    grossProfit: 0,
    grossLoss: 0,
    profitFactor: null,
    expectancy: 0,
    averageRMultiple: 0,
    maxRealizedDrawdownUsd: 0,
    averageHoldHours: 0,
  };
}

function baseline(): Phase6RunResult {
  return {
    config: {
      minConfluenceScore: 2,
      atrPeriod: 14,
      maPullbackAtrTolerance: 0.15,
      fvgLookbackBars: 12,
      profileLookbackBars: 96,
      profileBins: 24,
      profileValueAreaFraction: 0.7,
      entryExpiryMinutes: 15,
      breakEvenTriggerPrice: 6,
      breakEvenOffsetPrice: 2,
      trailingTriggerPrice: 10,
      trailingDistancePrice: 5,
    },
    metrics: {
      m15Bars: 30,
      engulfingTriggers: 1,
      trendAligned: 1,
      confluencePassed: 1,
      riskBlocked: 1,
      signals: 0,
      buySignals: 0,
      sellSignals: 0,
      filledTrades: 0,
      unfilledTrades: 0,
      wins: 0,
      losses: 0,
      flat: 0,
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
    signals: [],
    trades: [],
  };
}

function diagnostics(signalTimestamp: number): Phase6ADiagnosticsResult {
  const blocked = {
    id: `phase6-${signalTimestamp}-BUY`,
    side: "BUY" as const,
    signalTimestamp,
    canonicalEntry: 110,
    stopLoss: 95,
    requiredRiskAtMinVolumeUsd: 15,
    maPullback: true,
    fvg: true,
    volumeProfile: false,
    profile: null,
  };
  return {
    side: { BUY: zeroMetrics(), SELL: zeroMetrics() },
    confluence: {
      MA_FVG: zeroMetrics(),
      MA_VOLUME_PROFILE: zeroMetrics(),
      FVG_VOLUME_PROFILE: zeroMetrics(),
      MA_FVG_VOLUME_PROFILE: zeroMetrics(),
      OTHER: zeroMetrics(),
    },
    riskBlockedSetups: [blocked],
    rescueCases: [{
      ...blocked,
      rescued: true,
      rescueSource: "M5_MA20",
      rescueEntry: 100,
      rescueRiskUsd: 5,
      rescueFillTime: signalTimestamp,
    }],
    riskBlockedCount: 1,
    rescuedCount: 1,
    rescueRatePercent: 100,
    rescueSourceCounts: {
      M5_MA20: 1,
      M5_MA50: 0,
      M5_FVG: 0,
      M15_POC: 0,
      M15_VAH: 0,
      M15_VAL: 0,
    },
    walkForwardFolds: [],
    positiveFolds: 0,
  };
}

function request(signalTimestamp: number): Phase6RunRequest {
  const m15: Phase6Bar[] = Array.from({ length: 30 }, (_, index) => ({
    openTime: index * M15,
    closeTime: (index + 1) * M15,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
  }));
  m15[m15.length - 1] = {
    openTime: signalTimestamp - M15,
    closeTime: signalTimestamp,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
  };

  return {
    m15Bars: m15,
    m5Bars: [
      {
        openTime: signalTimestamp,
        closeTime: signalTimestamp + M5,
        open: 100,
        high: 107,
        low: 100,
        close: 106,
        volume: 100,
      },
      {
        openTime: signalTimestamp + M5,
        closeTime: signalTimestamp + 2 * M5,
        open: 106,
        high: 111,
        low: 106,
        close: 110,
        volume: 100,
      },
      {
        openTime: signalTimestamp + 2 * M5,
        closeTime: signalTimestamp + 3 * M5,
        open: 110,
        high: 110,
        low: 106,
        close: 107,
        volume: 100,
      },
    ],
    riskCapUsd: 10,
    tickSize: 0.01,
    tickValuePerLot: 1,
    minVolume: 0.01,
    volumeStep: 0.01,
  };
}

describe("Phase6BRescueOutcomeService", () => {
  it("replays a rescued entry with the structural stop and unchanged positive management", () => {
    const signalTimestamp = 30 * M15;
    const service = new Phase6BRescueOutcomeService();
    const result = service.run(baseline(), diagnostics(signalTimestamp), request(signalTimestamp));

    expect(result.rescuedTrades).toHaveLength(1);
    const trade = result.rescuedTrades[0]!;
    expect(trade.entry).toBe(100);
    expect(trade.stopLoss).toBe(95);
    expect(trade.initialRiskUsd).toBeLessThanOrEqual(10);
    expect(trade.volume).toBe(0.02);
    expect(trade.reachedPlus6).toBe(true);
    expect(trade.reachedPlus10).toBe(true);
    expect(trade.breakEvenApplied).toBe(true);
    expect(trade.trailingActivated).toBe(true);
    expect(trade.exitReason).toBe("STOP");
    expect(trade.exit).toBe(106);
    expect(trade.pnl).toBe(12);
    expect(result.rescuedMetrics.netPnl).toBe(12);
    expect(result.combinedMetrics.netPnl).toBe(12);
  });

  it("keeps Phase 6B explicitly research-only and non-retuned", () => {
    const signalTimestamp = 30 * M15;
    const service = new Phase6BRescueOutcomeService();
    const result = service.run(baseline(), diagnostics(signalTimestamp), request(signalTimestamp));
    const lines = service.format(result);

    expect(lines).toContain("PHASE6B_RESCUE_STRUCTURAL_STOP_PRESERVED=PASS");
    expect(lines).toContain("PHASE6B_PER_TRADE_RISK_CAP_PRESERVED=PASS");
    expect(lines).toContain("PHASE6B_MANAGEMENT_UNCHANGED=PASS");
    expect(lines).toContain("PHASE6B_NO_RETUNE=PASS");
    expect(lines).toContain("PHASE6B_PRODUCTION_MUTATION=false");
  });
});
