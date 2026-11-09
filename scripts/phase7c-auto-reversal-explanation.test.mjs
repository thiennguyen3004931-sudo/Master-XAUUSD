import assert from "node:assert/strict";
import test from "node:test";
import { buildPhase7CDecisionMonitor } from "../apps/api/src/services/phase7c-decision-monitor.service.ts";
import {
  buildPhase7CUiContract,
  formatPhase7CUiContractForMt5,
} from "../apps/api/src/services/phase7c-ui-contract.service.ts";

function fixture() {
  return {
    regime: {
      symbol: "XAUUSD",
      timeframe: "M15",
      regime: "REVERSAL",
      confidence: 82,
      recommendedMode: "PAUSE",
      activeMode: "AUTO",
      modeMatchesRecommendation: true,
      reversal: {
        direction: "BULLISH",
        side: "BUY",
        timestamp: 1_775_999_000_000,
        level: 2490,
      },
      reasons: ["A confirmed CHOCH indicates a possible structural reversal."],
      metrics: {},
      supplyDemandRange: null,
      lastCandleCloseTime: 1_776_000_000_000,
      checkedAt: 1_776_000_001_000,
    },
    demo: {
      botStatus: "WAITING_SIGNAL",
      entryDiagnostics: {
        closeTime: 1_776_000_000_000,
        pattern: { matched: true, name: "ENGULFING", side: "BUY" },
        trend: {
          confidenceScore: 80,
          confidenceLevel: "RẤT_CAO",
          m15Supertrend: "SELL",
          m5Supertrend: "SELL",
        },
        entry: {
          eligible: false,
          reversalEligible: true,
          side: "BUY",
          referenceEntry: 2500,
          structuralStopDistance: 5,
          stopDistance: null,
          reversalStopDistance: 6,
          action: "WAIT_SIGNAL",
          reason: "REVERSAL uses CHOCH direction + pattern + structure; SuperTrend is ignored.",
        },
      },
    },
    telemetry: {
      enabled: true,
      configured: true,
      reachable: true,
      status: "HEALTHY",
      message: "ok",
      latencyMs: 1,
      bridgeBaseUrl: "http://127.0.0.1:8765",
      health: { accountMode: "demo", accountBalance: 10_000, accountCurrency: "USD", timestamp: 1 },
      quote: null,
      spec: { cashPerPriceUnitPerLot: 100 },
      positions: [],
      checkedAt: 1,
    },
    lots: {
      state: { version: 1, trendFixedLot: 0.12, sidewayRiskPercent: 1, sidewayMaxLot: 0.3, updatedAt: "", updatedBy: "test" },
      active: { version: 1, trendFixedLot: 0.12, sidewayRiskPercent: 1, sidewayMaxLot: 0.3, armed: true, supervisorPid: 1, appliedAt: "" },
      activeAlive: true,
      restartRequired: false,
      appliesTo: "NEW_POSITIONS_ONLY",
      safety: {},
      limits: {},
    },
    audit: [],
    now: 1_776_000_002_000,
  };
}

test("AUTO REVERSAL explanation distinguishes regime recommendation from canonical effective Trend strategy", () => {
  const snapshot = buildPhase7CDecisionMonitor(fixture());
  assert.equal(snapshot.mode.active, "AUTO");
  assert.equal(snapshot.engine.regime, "REVERSAL");
  assert.equal(snapshot.engine.recommendedMode, "PAUSE");
  assert.equal(snapshot.mode.effectiveStrategy, "TREND");
  assert.equal(snapshot.preTrade.approved, true);

  const ui = buildPhase7CUiContract(snapshot);
  const reason = ui.reasons.auto[0] ?? "";
  assert.match(reason, /khuyến nghị PAUSE/i);
  assert.match(reason, /strategy hiệu lực TREND/i);
  assert.doesNotMatch(reason, /→ chọn PAUSE/i);

  const mt5Payload = formatPhase7CUiContractForMt5(ui);
  const autoReasonLine = mt5Payload.split("\n").find((line) => line.startsWith("autoReason1=")) ?? "";
  assert.match(autoReasonLine, /khuyến nghị PAUSE/i);
  assert.match(autoReasonLine, /strategy hiệu lực TREND/i);
  assert.doesNotMatch(autoReasonLine, /→ chọn PAUSE/i);
});
