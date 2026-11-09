import assert from "node:assert/strict";
import test from "node:test";
import { buildPhase7CDecisionMonitor } from "../apps/api/src/services/phase7c-decision-monitor.service.ts";

function fixture() {
  const now = 1_776_000_000_000;
  const staleSidewayDecision = {
    timestamp: now - 31 * 60_000,
    strategy: "SIDEWAY",
    event: "ENTRY_READY",
    stage: "READY",
    reason: "Historical Sideway setup was ready.",
    setup: {
      side: "BUY",
      pattern: "DEMAND_REJECTION",
      activeMode: "AUTO",
      recommendedMode: "SIDEWAY",
      regime: "RANGING",
      confidence: 82,
    },
    sizing: {
      rawLot: 0.09,
      finalLot: 0.09,
      maxLot: 0.3,
      riskPercent: 1,
      estimatedRiskUsd: 54,
      estimatedRiskPercent: 0.54,
    },
    plan: {
      entry: 2500,
      stopLoss: 2494,
      stopDistance: 6,
      breakEvenPrice: 2500,
      tp1: 2510,
      tp2: 2520,
    },
  };

  return {
    regime: {
      symbol: "XAUUSD",
      timeframe: "M15",
      regime: "RANGING",
      confidence: 82,
      recommendedMode: "SIDEWAY",
      activeMode: "AUTO",
      modeMatchesRecommendation: true,
      reasons: ["Canonical Sideway regime is active."],
      metrics: {},
      supplyDemandRange: { lower: 2490, upper: 2520 },
      lastCandleCloseTime: now - 60_000,
      checkedAt: now - 1_000,
    },
    demo: {
      botStatus: "WAITING_SIGNAL",
      entryDiagnostics: null,
      entryDiagnosticsError: null,
    },
    telemetry: {
      enabled: true,
      configured: true,
      reachable: true,
      status: "HEALTHY",
      message: "ok",
      latencyMs: 1,
      bridgeBaseUrl: "http://127.0.0.1:8765",
      health: {
        accountMode: "demo",
        accountBalance: 10_000,
        accountCurrency: "USD",
        timestamp: now,
      },
      quote: null,
      spec: { cashPerPriceUnitPerLot: 100 },
      positions: [],
      checkedAt: now,
    },
    lots: {
      state: {
        version: 1,
        trendFixedLot: 0.12,
        sidewayRiskPercent: 1,
        sidewayMaxLot: 0.3,
        updatedAt: "",
        updatedBy: "test",
      },
      active: {
        version: 1,
        trendFixedLot: 0.12,
        sidewayRiskPercent: 1,
        sidewayMaxLot: 0.3,
        armed: true,
        supervisorPid: 1,
        appliedAt: "",
      },
      activeAlive: true,
      restartRequired: false,
      appliesTo: "NEW_POSITIONS_ONLY",
      safety: {},
      limits: {},
    },
    audit: [staleSidewayDecision],
    now,
    staleSidewayDecision,
  };
}

test("stale Sideway audit stays in history but cannot populate current pre-trade fields", () => {
  const input = fixture();
  const snapshot = buildPhase7CDecisionMonitor(input);

  assert.equal(snapshot.preTrade.strategy, "SIDEWAY");
  assert.equal(snapshot.preTrade.approved, false);
  assert.equal(snapshot.preTrade.stage, "WAITING");

  assert.equal(snapshot.preTrade.side, null);
  assert.equal(snapshot.preTrade.setup, null);
  assert.equal(snapshot.preTrade.entry, null);
  assert.equal(snapshot.preTrade.stopLoss, null);
  assert.equal(snapshot.preTrade.stopDistance, null);
  assert.equal(snapshot.preTrade.breakEvenPrice, null);
  assert.equal(snapshot.preTrade.tp1, null);
  assert.equal(snapshot.preTrade.tp2, null);
  assert.equal(snapshot.preTrade.rawLot, null);
  assert.equal(snapshot.preTrade.finalLot, null);
  assert.equal(snapshot.preTrade.estimatedRiskUsd, null);
  assert.equal(snapshot.preTrade.estimatedRiskPercent, null);

  const historical = snapshot.recentDecisions.find(
    (row) => row.strategy === "SIDEWAY" && row.event === "ENTRY_READY",
  );
  assert.ok(historical, "stale Sideway decision must remain available for audit history");
  assert.equal(historical.timestamp, input.staleSidewayDecision.timestamp);
  assert.equal(historical.plan?.entry, 2500);
  assert.equal(historical.sizing?.finalLot, 0.09);
});
