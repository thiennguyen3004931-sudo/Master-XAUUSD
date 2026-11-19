import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPhase7CDecisionMonitor,
  formatPhase7CDecisionMonitorForMt5,
} from "../apps/api/src/services/phase7c-decision-monitor.service.ts";
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
        timestamp: now - 1_000,
        strategy: "TREND",
        event: "FVG_HOLD_CONFIRMED",
        stage: "MANAGING",
        reason: "FVG_HOLD_CONFIRMED",
        setup: { side: "BUY", pattern: "ENGULFING" },
        management: { ticket: firstTicket, breakEvenApplied: true, partialApplied: true },
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

test("multiple XAUUSD positions fail closed instead of presenting the first ticket as canonically managed", () => {
  const source = input();
  const snapshot = buildPhase7CDecisionMonitor(source);

  assert.equal(snapshot.position.count, 2);
  assert.equal(
    snapshot.position.state,
    "UNMANAGED",
    "both executors reject additional XAUUSD positions, so the monitor must not present positions[0] as MANAGING",
  );
  assert.equal(snapshot.position.strategy, null);
  assert.equal(snapshot.position.ticket, "9001", "the first broker ticket may remain visible for diagnosis");
  assert.match(snapshot.position.entryReason, /không khớp state/i);
  assert.match(snapshot.position.holdReason, /không thuộc state executor/i);
  assert.equal(snapshot.position.holdReasonCode, null);
  assert.equal(snapshot.position.breakEvenApplied, false);
  assert.equal(snapshot.position.partialApplied, false);

  const decisionMt5 = formatPhase7CDecisionMonitorForMt5(snapshot);
  assert.match(decisionMt5, /^positionCount=2$/m);
  assert.match(decisionMt5, /^positionState=UNMANAGED$/m);
  assert.match(decisionMt5, /^positionStrategy=n\/a$/m);

  const ui = buildPhase7CUiContract(snapshot);
  assert.equal(ui.uiState, "MANAGING", "an anomalous open position remains visible in the MANAGING screen");
  assert.equal(ui.position?.state, "UNMANAGED");
  assert.equal(ui.position?.strategy, null);
  assert.match(ui.reasons.entry[0] ?? "", /không khớp state/i);
  assert.match(ui.reasons.hold[0] ?? "", /không thuộc state executor/i);

  const uiMt5 = formatPhase7CUiContractForMt5(ui);
  assert.match(uiMt5, /^positionState=UNMANAGED$/m);
  assert.match(uiMt5, /^positionStrategy=n\/a$/m);
  assert.doesNotMatch(uiMt5, /HOLD_TREND_STRUCTURE_INTACT/);
});
