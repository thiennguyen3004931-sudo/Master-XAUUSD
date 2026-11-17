import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  buildPhase7CDecisionMonitor,
  formatPhase7CDecisionMonitorForMt5,
} from "../apps/api/src/services/phase7c-decision-monitor.service.ts";
import { buildPhase7CUiContract } from "../apps/api/src/services/phase7c-ui-contract.service.ts";

function fixture(overrides = {}) {
  const now = 1_789_000_000_000;
  return {
    regime: {
      symbol: "XAUUSD",
      timeframe: "M15",
      regime: "TRENDING",
      confidence: 72,
      recommendedMode: "TREND",
      activeMode: "SEMI",
      modeMatchesRecommendation: false,
      reasons: ["Trend context remains valid."],
      metrics: {},
      supplyDemandRange: null,
      lastCandleCloseTime: now - 60_000,
      checkedAt: now - 1_000,
    },
    demo: {
      botStatus: "WAITING_SIGNAL",
      entryDiagnostics: {
        pattern: { matched: true, name: "ENGULFING", side: "BUY" },
        trend: { confidenceScore: 80, confidenceLevel: "RẤT_CAO" },
        entry: {
          eligible: true,
          side: "BUY",
          referenceEntry: 2500,
          structuralStopDistance: 6,
          stopDistance: 6,
          action: "ENTRY_IMMEDIATE",
          reason: "Canonical Trend setup is valid.",
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
      quote: { bid: 2505, ask: 2505.2, spread: 0.2, timestamp: now },
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
    audit: [],
    accountModeState: {
      version: 1,
      accountMode: "DEMO",
      liveExecutionEnabled: false,
      valid: true,
      error: null,
      source: "TEST",
    },
    now,
    ...overrides,
  };
}

test("flat SEMI is manual-entry-only and never collapses to PAUSE", () => {
  const snapshot = buildPhase7CDecisionMonitor(fixture());

  assert.equal(snapshot.mode.active, "SEMI");
  assert.equal(snapshot.mode.effectiveStrategy, null);
  assert.equal(snapshot.preTrade.strategy, null);
  assert.equal(snapshot.preTrade.approved, false);
  assert.equal(snapshot.preTrade.stage, "BLOCKED");
  assert.match(snapshot.preTrade.limitReason, /SEMI|thủ công|manual/i);

  const mt5 = formatPhase7CDecisionMonitorForMt5(snapshot);
  assert.match(mt5, /^activeMode=SEMI$/m);
  assert.match(mt5, /^effectiveStrategy=n\/a$/m);
  assert.match(mt5, /^entryReason=.*(?:SEMI|thủ công|manual).*$/im);
  assert.doesNotMatch(mt5, /^entryReason=Bot đang PAUSE/m);

  const ui = buildPhase7CUiContract(snapshot);
  assert.equal(ui.mode, "SEMI");
  assert.equal(ui.effectiveStrategy, null);
  assert.equal(ui.approved, false);
  assert.equal(ui.gates.trend, "BLOCKED_BY_MODE");
  assert.equal(ui.gates.sideway, "BLOCKED_BY_MODE");
  assert.ok(
    [...ui.reasons.auto, ...ui.reasons.trendWait, ...ui.reasons.sidewayWait, ...ui.reasons.wait]
      .some((reason) => /SEMI|thủ công|manual/i.test(reason)),
    "SEMI UI must explain manual-entry-only semantics",
  );
});

test("protected MANUAL_SEMI owner resolves to TREND management without authorizing system entry", () => {
  const input = fixture();
  input.telemetry.positions = [{
    ticket: "91001",
    symbol: "XAUUSD",
    brokerSymbol: "XAUUSD",
    side: "LONG",
    volume: 0.12,
    entry: 2500,
    stopLoss: 2494,
    takeProfit: 0,
    profit: 50,
    swap: 0,
    commission: 0,
    openedAt: input.now - 60_000,
  }];
  input.semiAdoptions = [{
    version: 1,
    ownershipId: "semi-91001",
    ticket: "91001",
    openingDealTicket: "81001",
    symbol: "XAUUSD",
    accountLogin: "123456",
    entrySource: "MANUAL",
    managementStrategy: "TREND",
    side: "LONG",
    entry: 2500,
    initialVolume: 0.12,
    expectedRemainingVolume: 0.12,
    activationEpochMs: input.now - 120_000,
    manualOpenedAt: input.now - 90_000,
    managementStartedAt: input.now - 80_000,
    initialStopDistance: 6,
    targetStopLoss: 2494,
    tightestStopLoss: 2494,
    protectionStatus: "PROTECTED",
    protectionReason: "INITIAL_SL_VERIFIED",
    fixedTakeProfit: { enabled: false, targetPrice: null },
    updatedAt: input.now - 30_000,
  }];

  const snapshot = buildPhase7CDecisionMonitor(input);
  assert.equal(snapshot.mode.active, "SEMI");
  assert.equal(snapshot.mode.effectiveStrategy, "TREND");
  assert.equal(snapshot.position.state, "MANAGING");
  assert.equal(snapshot.position.strategy, "TREND");
  assert.equal(snapshot.preTrade.approved, false);
  assert.match(snapshot.position.entryReason, /SEMI|thủ công|manual/i);
});

test("Trend broker POST boundary has an explicit SEMI manual-entry-only block", () => {
  const source = fs.readFileSync(
    new URL("./run-phase7c-trend-controller.mjs", import.meta.url),
    "utf8",
  );
  const boundaryStart = source.indexOf("globalThis.fetch = async function phase7CTrendGate");
  const boundaryEnd = source.indexOf("await importLegacyTrendController()", boundaryStart);
  assert.ok(boundaryStart >= 0 && boundaryEnd > boundaryStart, "Trend POST boundary wrapper must exist");
  const boundary = source.slice(boundaryStart, boundaryEnd);
  assert.match(boundary, /activeMode\s*===\s*["']SEMI["']/);
  assert.match(boundary, /SEMI_[A-Z0-9_]*(?:MANUAL|ENTRY)[A-Z0-9_]*/);
  assert.match(boundary, /return\s+await\s+nativeFetch\(input,\s*init\)/);
});

test("Sideway re-checks SEMI immediately after durable pending state and before broker POST", () => {
  const source = fs.readFileSync(
    new URL("./run-phase7c-sideway-controller.mjs", import.meta.url),
    "utf8",
  );
  const pending = source.indexOf('journal("ENTRY_PENDING_DURABLE"');
  const submit = source.indexOf('bridgeRequest("POST", "/v1/orders"', pending);
  assert.ok(pending >= 0 && submit > pending, "Sideway durable-pending -> broker POST boundary must exist");
  const boundary = source.slice(pending, submit);
  assert.match(boundary, /controlGet\(["']\/api\/v1\/phase7c\/bot-mode["']\)/);
  assert.match(boundary, /SEMI/);
  assert.match(boundary, /ENTRY_[A-Z0-9_]*(?:SEMI|MODE)[A-Z0-9_]*BLOCK/);
});
