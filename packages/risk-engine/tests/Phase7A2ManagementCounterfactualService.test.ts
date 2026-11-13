import { describe, expect, it } from "vitest";
import {
  Phase7A2ManagementCounterfactualService,
  type Phase7RunRequest,
  type Phase7RunResult,
  type Phase7TradeResult,
} from "../src";

function trade(): Phase7TradeResult {
  return {
    id: "phase7-test-buy",
    side: "BUY",
    signalTimestamp: 1,
    entry: 100,
    engulfingExtreme: 99,
    structuralStopDistance: 1,
    stopDistance: 6,
    stopLoss: 94,
    volume: 0.03,
    initialRiskUsd: 18,
    ma20: 99,
    ma50: 98,
    ma200: 97,
    fvg: true,
    filled: true,
    entryTime: 1,
    exitTime: 2,
    exit: 112,
    finalStopLoss: 107,
    pnl: 28,
    rMultiple: 28 / 18,
    holdHours: 1,
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
  };
}

const request: Phase7RunRequest = {
  m15Bars: [],
  m5Bars: [],
  fixedVolume: 0.03,
  tickSize: 0.01,
  tickValuePerLot: 1,
  minVolume: 0.01,
  volumeStep: 0.01,
};

const result: Phase7RunResult = {
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
  metrics: {} as Phase7RunResult["metrics"],
  signals: [],
  trades: [trade()],
};

describe("Phase7A2ManagementCounterfactualService", () => {
  it("isolates current, full hold, +6-only and +10-only volume management on the same exit path", () => {
    const diagnostics = new Phase7A2ManagementCounterfactualService().analyze(result, request);
    expect(diagnostics.lines).toContain(
      "PHASE7A2_ALL_DELTA_VS_CURRENT=FULL_HOLD:8|PARTIAL_6_ONLY:2|PARTIAL_10_ONLY:6",
    );
    expect(diagnostics.lines).toContain("PHASE7A2_AUTO_SELECTION=OFF");
    expect(diagnostics.lines).toContain("PHASE7A2_NO_RETUNE=PASS");
  });
});
