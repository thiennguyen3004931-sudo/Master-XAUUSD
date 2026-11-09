import assert from "node:assert/strict";
import test from "node:test";
import { buildPhase7CDecisionMonitor } from "../apps/api/src/services/phase7c-decision-monitor.service.ts";
import { buildPhase7CUiContract } from "../apps/api/src/services/phase7c-ui-contract.service.ts";

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

test("AUTO REVERSAL UI gate follows the canonical effective Trend strategy", () => {
  const snapshot = buildPhase7CDecisionMonitor(fixture());
  assert.equal(snapshot.mode.active, "AUTO");
  assert.equal(snapshot.engine.regime, "REVERSAL");
  assert.equal(snapshot.engine.recommendedMode, "PAUSE");
  assert.equal(snapshot.mode.effectiveStrategy, "TREND");
  assert.equal(snapshot.preTrade.approved, true);

  const ui = buildPhase7CUiContract(snapshot);
  assert.equal(ui.gates.trend, "ALLOWED");
  assert.equal(ui.gates.reversalFilter, "CLEAR");
  assert.equal(ui.status.trendOn, true);
  assert.equal(
    ui.entryChecks.trend.find((check) => check.code === "TREND_MODE_REGIME")?.status,
    "PASS",
  );
  assert.doesNotMatch(
    ui.reasons.trendWait.join("\n"),
    /AUTO hiện chưa chọn TREND/,
  );
  assert.doesNotMatch(
    ui.reasons.trendWait.join("\n"),
    /Supertrend/i,
  );

  const chochDirectionCheck = ui.entryChecks.trend.find(
    (check) => check.code === "TREND_REVERSAL_CHOCH_DIRECTION",
  );
  const chochFreshnessCheck = ui.entryChecks.trend.find(
    (check) => check.code === "TREND_REVERSAL_SIGNAL_AFTER_CHOCH",
  );
  assert.equal(chochDirectionCheck?.status, "PASS");
  assert.match(chochDirectionCheck?.actual ?? "", /BULLISH.*BUY.*signal BUY/i);
  assert.equal(chochFreshnessCheck?.status, "PASS");
  assert.match(chochFreshnessCheck?.required ?? "", /> 1775999000000/);

  const m15Check = ui.entryChecks.trend.find((check) => check.code === "TREND_SUPERTREND_M15");
  const m5Check = ui.entryChecks.trend.find((check) => check.code === "TREND_SUPERTREND_M5");
  assert.equal(m15Check?.status, "IGNORED");
  assert.equal(m5Check?.status, "IGNORED");
  assert.match(m15Check?.actual ?? "", /IGNORED.*SELL/i);
  assert.match(m5Check?.actual ?? "", /IGNORED.*SELL/i);
  assert.match(m15Check?.required ?? "", /Không áp dụng cho REVERSAL/i);
  assert.match(m5Check?.required ?? "", /Không áp dụng cho REVERSAL/i);
});
