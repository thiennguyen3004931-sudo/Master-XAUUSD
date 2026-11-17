import assert from "node:assert/strict";
import test from "node:test";
import { buildPhase7CDecisionMonitor } from "../apps/api/src/services/phase7c-decision-monitor.service.ts";
import {
  buildPhase7CUiContract,
  formatPhase7CUiContractForMt5,
} from "../apps/api/src/services/phase7c-ui-contract.service.ts";

function input() {
  const now = 1_776_000_002_000;
  const firstTicket = "9001";
  return {
    regime: {
      symbol: "XAUUSD",
      timeframe: "M15",
      regime: "TRENDING",
      confidence: 82,
      recommendedMode: "TREND",
      activeMode: "AUTO",
      modeMatchesRecommendation: true,
      reasons: ["ADX and structure support trend."],
      metrics: {},
      supplyDemandRange: null,
      lastCandleCloseTime: now - 60_000,
      checkedAt: now,
    },
    demo: {
      botStatus: "WAITING_SIGNAL",
      entryDiagnostics: {
        pattern: { matched: false, name: null, side: null },
        trend: { confidenceScore: 80, confidenceLevel: "CAO" },
        entry: {
          eligible: false,
          side: null,
          referenceEntry: 2500,
          stopDistance: 6,
          action: "WAIT_SIGNAL",
          reason: "Waiting for the next Trend setup.",
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
      health: {
        accountMode: "demo",
        accountBalance: 10_000,
        accountCurrency: "USD",
        timestamp: now,
      },
      quote: { bid: 2511, ask: 2511.2, spread: 0.2, timestamp: now },
      spec: { cashPerPriceUnitPerLot: 100 },
      positions: [
        {
          ticket: firstTicket,
          symbol: "XAUUSD",
          brokerSymbol: "XAUUSD",
          side: "LONG",
          volume: 0.08,
          entry: 2500,
          stopLoss: 2500,
          takeProfit: 0,
          profit: 131.5,
          swap: -1,
          commission: -0.5,
          openedAt: now - 60_000,
        },
        {
          ticket: "9002",
          symbol: "XAUUSD",
          brokerSymbol: "XAUUSD",
          side: "SHORT",
          volume: 0.03,
          entry: 2508,
          stopLoss: 2514,
          takeProfit: 0,
          profit: -8,
          swap: 0,
          commission: -0.2,
          openedAt: now - 30_000,
        },
      ],
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
    managedStates: {
      TREND: {
        ticket: firstTicket,
        side: "BUY",
        pattern: "ENGULFING",
        entry: 2500,
        initialVolume: 0.12,
        breakEvenApplied: true,
        partialApplied: true,
      },
      SIDEWAY: null,
    },
    audit: [
      {
        timestamp: now - 100,
        strategy: "TREND",
        event: "PLUS6_SL_TO_ENTRY",
        stage: "MANAGING",
        reason: "PLUS6_SL_TO_ENTRY",
        management: { ticket: firstTicket, breakEvenApplied: true },
      },
      {
        timestamp: now - 200,
        strategy: "TREND",
        event: "PLUS10_PARTIAL_ONE_THIRD",
        stage: "MANAGING",
        reason: "PLUS10_PARTIAL_ONE_THIRD",
        management: { ticket: firstTicket, partialApplied: true },
      },
      {
        timestamp: now - 300,
        strategy: "TREND",
        event: "MANAGEMENT_EXIT_SIGNAL",
        stage: "MANAGING",
        reason: "Historical ticket exit condition must not describe an ambiguous multi-position state.",
        management: { ticket: firstTicket },
      },
      {
        timestamp: now - 60_000,
        strategy: "TREND",
        event: "ENTRY_FILLED",
        stage: "FILLED",
        reason: "ENTRY_FILLED",
        setup: { side: "BUY", pattern: "ENGULFING" },
        plan: { entry: 2500, stopLoss: 2494, tp1: 2510 },
        management: { ticket: firstTicket },
      },
    ],
    now,
  };
}

test("multiple-position UNMANAGED state does not regain canonical management reasons in the UI layer", () => {
  const snapshot = buildPhase7CDecisionMonitor(input());
  assert.equal(snapshot.position.count, 2);
  assert.equal(snapshot.position.state, "UNMANAGED");
  assert.equal(snapshot.position.strategy, null);

  const ui = buildPhase7CUiContract(snapshot);
  assert.equal(ui.uiState, "MANAGING", "open broker risk remains visible on the managing screen");
  assert.equal(ui.position?.state, "UNMANAGED");
  assert.match(ui.reasons.entry[0] ?? "", /không khớp state/i);
  assert.match(ui.reasons.hold[0] ?? "", /không thuộc state executor/i);
  assert.deepEqual(
    ui.reasons.stopMove,
    [],
    "UNMANAGED multi-position state must not present DỜI SL history from positions[0] as canonical current management",
  );
  assert.deepEqual(
    ui.reasons.partial,
    [],
    "UNMANAGED multi-position state must not present CHỐT 1/3 history from positions[0] as canonical current management",
  );
  assert.deepEqual(
    ui.reasons.exit,
    [],
    "UNMANAGED multi-position state must not present exit history from positions[0] as canonical current management",
  );

  const mt5 = formatPhase7CUiContractForMt5(ui);
  assert.match(mt5, /^positionState=UNMANAGED$/m);
  assert.match(mt5, /^stopMoveReason1=n\/a$/m);
  assert.match(mt5, /^partialReason1=n\/a$/m);
  assert.match(mt5, /^exitReason1=n\/a$/m);
});
