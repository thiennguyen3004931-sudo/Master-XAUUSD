import assert from "node:assert/strict";
import test from "node:test";
import { buildPhase7CDecisionMonitor } from "../apps/api/src/services/phase7c-decision-monitor.service.ts";
import {
  buildPhase7CUiContract,
  formatPhase7CUiContractForMt5,
} from "../apps/api/src/services/phase7c-ui-contract.service.ts";

function fixture() {
  const now = 1_776_000_000_000;
  const staleSidewayDecision = {
    timestamp: now - 31 * 60_000,
    strategy: "SIDEWAY",
    event: "ENTRY_SUBMIT",
    stage: "SUBMITTED",
    reason: "Historical Sideway order was submitted.",
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

function checkByCode(ui, code) {
  const check = ui.entryChecks.sideway.find((row) => row.code === code);
  assert.ok(check, `missing Sideway check ${code}`);
  return check;
}

test("stale Sideway submit history cannot keep current entry-progress checks PASS", () => {
  const input = fixture();
  const snapshot = buildPhase7CDecisionMonitor(input);

  assert.equal(snapshot.preTrade.strategy, "SIDEWAY");
  assert.equal(snapshot.preTrade.stage, "WAITING");
  assert.equal(snapshot.preTrade.approved, false);
  assert.equal(snapshot.preTrade.entry, null);
  assert.equal(snapshot.preTrade.finalLot, null);

  const historical = snapshot.recentDecisions.find(
    (row) => row.strategy === "SIDEWAY" && row.event === "ENTRY_SUBMIT",
  );
  assert.ok(historical, "stale Sideway submit must remain in audit history");
  assert.equal(historical.timestamp, input.staleSidewayDecision.timestamp);
  assert.equal(historical.plan?.entry, 2500);
  assert.equal(historical.sizing?.finalLot, 0.09);

  const ui = buildPhase7CUiContract(snapshot);
  assert.equal(ui.uiState, "WAITING");
  assert.equal(checkByCode(ui, "SIDEWAY_MODE_REGIME").status, "PASS");
  assert.equal(checkByCode(ui, "SIDEWAY_RANGE").status, "PASS");
  assert.equal(checkByCode(ui, "SIDEWAY_LOCATION").status, "WAIT");
  assert.equal(checkByCode(ui, "SIDEWAY_M5_CONFIRMATION").status, "WAIT");
  assert.equal(checkByCode(ui, "SIDEWAY_FINAL_GATE").status, "WAIT");
  assert.equal(checkByCode(ui, "SIDEWAY_AUTO_LOT").status, "WAIT");

  const mt5 = formatPhase7CUiContractForMt5(ui);
  assert.match(mt5, /sidewayCheck3Status=WAIT/);
  assert.match(mt5, /sidewayCheck4Status=WAIT/);
  assert.match(mt5, /sidewayCheck5Status=WAIT/);
  assert.match(mt5, /sidewayCheck6Status=WAIT/);
});
