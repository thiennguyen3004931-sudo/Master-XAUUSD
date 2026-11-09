import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  buildPhase7CDecisionMonitor,
  formatPhase7CDecisionMonitorForMt5,
} from "../apps/api/src/services/phase7c-decision-monitor.service.ts";
import { assertPhase7CSelectedAccountReady } from "../apps/api/src/services/phase7c-lifecycle.service.ts";

function fixture(overrides = {}) {
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
      lastCandleCloseTime: 1_776_000_000_000,
      checkedAt: 1_776_000_001_000,
    },
    demo: {
      botStatus: "WAITING_SIGNAL",
      entryDiagnostics: {
        closeTime: 1_776_000_000_000,
        pattern: { matched: true, name: "ENGULFING", side: "BUY" },
        trend: { confidenceScore: 80, confidenceLevel: "RẤT_CAO" },
        entry: {
          eligible: true,
          reversalEligible: true,
          side: "BUY",
          referenceEntry: 2500,
          structuralStopDistance: 5,
          stopDistance: 6,
          reversalStopDistance: 6,
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
    ...overrides,
  };
}

test("decision monitor calculates the active Trend lot and exact risk before entry", () => {
  const snapshot = buildPhase7CDecisionMonitor(fixture());
  assert.equal(snapshot.preTrade.strategy, "TREND");
  assert.equal(snapshot.preTrade.approved, true);
  assert.equal(snapshot.preTrade.finalLot, 0.12);
  assert.equal(snapshot.preTrade.stopDistance, 6);
  assert.equal(snapshot.preTrade.estimatedRiskUsd, 72);
  assert.equal(snapshot.preTrade.estimatedRiskPercent, 0.72);
  assert.equal(snapshot.preTrade.tp1, 2510);
  assert.deepEqual(snapshot.engine.reasons, ["ADX and structure support trend."]);
});

test("decision monitor preserves canonical Sideway entry conditions from the audit journal", () => {
  const input = fixture();
  input.regime = {
    ...input.regime,
    regime: "RANGING",
    recommendedMode: "SIDEWAY",
    reasons: ["Canonical Sideway regime is active."],
  };
  const entryConditions = {
    configVersion: 3,
    side: "BUY",
    anchorCondition: "rangeEdge",
    enabledCount: 6,
    allEnabledPassed: true,
    failedConditions: [],
    conditions: [
      { id: "rangingRegime", enabled: true, mandatory: false, status: "PASS", observed: "RANGING" },
      { id: "recommendedModeSideway", enabled: true, mandatory: false, status: "PASS", observed: "SIDEWAY" },
      { id: "minimumRegimeConfidence", enabled: true, mandatory: false, status: "PASS", observed: 82 },
      { id: "supplyDemandRange", enabled: true, mandatory: false, status: "PASS", observed: "DEMAND" },
      { id: "rangeEdge", enabled: true, mandatory: true, status: "PASS", observed: "LOWER_EDGE" },
      { id: "m5Confirmation", enabled: true, mandatory: false, status: "PASS", observed: "BULLISH" },
    ],
  };
  input.audit = [{
    timestamp: input.now - 1_000,
    strategy: "SIDEWAY",
    event: "ENTRY_READY",
    stage: "READY",
    reason: "Canonical Sideway entry conditions passed.",
    setup: { side: "BUY", pattern: "DEMAND_REJECTION" },
    entryConditions,
  }];

  const snapshot = buildPhase7CDecisionMonitor(input);
  assert.equal(snapshot.preTrade.strategy, "SIDEWAY");
  assert.deepEqual(snapshot.strategyEntryConditions.sideway, entryConditions);
});

test("AUTO permits only a newer CHOCH-direction REVERSAL entry and does not require SuperTrend continuation eligibility", () => {
  const input = fixture();
  input.regime = {
    ...input.regime,
    regime: "REVERSAL",
    recommendedMode: "PAUSE",
    modeMatchesRecommendation: true,
    reversal: {
      direction: "BULLISH",
      side: "BUY",
      timestamp: 1_775_999_000_000,
      level: 2490,
    },
    reasons: ["A confirmed CHOCH indicates a possible structural reversal."],
  };
  input.demo.entryDiagnostics.entry.eligible = false;
  input.demo.entryDiagnostics.entry.reversalEligible = true;

  const snapshot = buildPhase7CDecisionMonitor(input);
  assert.equal(snapshot.mode.active, "AUTO");
  assert.equal(snapshot.engine.regime, "REVERSAL");
  assert.equal(snapshot.engine.recommendedMode, "PAUSE");
  assert.equal(snapshot.mode.effectiveStrategy, "TREND");
  assert.equal(snapshot.preTrade.strategy, "TREND");
  assert.equal(snapshot.preTrade.approved, true);
  assert.equal(snapshot.preTrade.side, "BUY");
  assert.equal(snapshot.preTrade.stopDistance, 6);
  assert.doesNotMatch(snapshot.preTrade.decisionReason, /Supertrend.*chưa cùng hướng/i);
  assert.match(snapshot.preTrade.decisionReason, /REVERSAL|CHOCH/i);
});

test("AUTO keeps REVERSAL fail-closed when reversal pattern/structure readiness is false", () => {
  const input = fixture();
  input.regime = {
    ...input.regime,
    regime: "REVERSAL",
    recommendedMode: "PAUSE",
    modeMatchesRecommendation: true,
    reversal: {
      direction: "BULLISH",
      side: "BUY",
      timestamp: 1_775_999_000_000,
      level: 2490,
    },
  };
  input.demo.entryDiagnostics.entry.eligible = true;
  input.demo.entryDiagnostics.entry.reversalEligible = false;
  input.demo.entryDiagnostics.entry.action = "WAIT_SIGNAL";

  const snapshot = buildPhase7CDecisionMonitor(input);
  assert.equal(snapshot.mode.active, "AUTO");
  assert.equal(snapshot.mode.effectiveStrategy, "PAUSE");
  assert.equal(snapshot.preTrade.strategy, "PAUSE");
  assert.equal(snapshot.preTrade.approved, false);
});

test("AUTO keeps REVERSAL fail-closed when entry side disagrees with CHOCH direction", () => {
  const input = fixture();
  input.regime = {
    ...input.regime,
    regime: "REVERSAL",
    recommendedMode: "PAUSE",
    modeMatchesRecommendation: true,
    reversal: {
      direction: "BEARISH",
      side: "SELL",
      timestamp: 1_775_999_000_000,
      level: 2510,
    },
  };
  input.demo.entryDiagnostics.entry.reversalEligible = true;

  const snapshot = buildPhase7CDecisionMonitor(input);
  assert.equal(snapshot.mode.effectiveStrategy, "PAUSE");
  assert.equal(snapshot.preTrade.strategy, "PAUSE");
  assert.equal(snapshot.preTrade.approved, false);
});

test("AUTO REVERSAL exception never bypasses active-lot hard safety", () => {
  const input = fixture();
  input.regime = {
    ...input.regime,
    regime: "REVERSAL",
    recommendedMode: "PAUSE",
    modeMatchesRecommendation: true,
    reversal: {
      direction: "BULLISH",
      side: "BUY",
      timestamp: 1_775_999_000_000,
      level: 2490,
    },
  };
  input.demo.entryDiagnostics.entry.eligible = false;
  input.demo.entryDiagnostics.entry.reversalEligible = true;
  input.lots.restartRequired = true;

  const snapshot = buildPhase7CDecisionMonitor(input);
  assert.equal(snapshot.mode.effectiveStrategy, "TREND");
  assert.equal(snapshot.preTrade.strategy, "TREND");
  assert.equal(snapshot.preTrade.approved, false);
  assert.equal(snapshot.preTrade.stage, "BLOCKED");
  assert.match(snapshot.preTrade.limitReason, /restart an toàn/i);
});

test("MT5 payload remains read-only and carries the canonical decision", () => {
  const payload = formatPhase7CDecisionMonitorForMt5(buildPhase7CDecisionMonitor(fixture()));
  assert.match(payload, /^version=1/m);
  assert.match(payload, /^finalLot=0\.12/m);
  assert.match(payload, /^estimatedRiskUsd=72/m);
  assert.match(payload, /^mt5OrderPermission=NONE/m);
  assert.match(payload, /^positionState=FLAT/m);
  assert.match(payload, /^holdReason=Chờ setup hợp lệ; panel không có quyền gửi lệnh\./m);
});

test("MT5 payload explains PAUSE in Vietnamese instead of leaking a long engine reason", () => {
  const input = fixture();
  input.regime = {
    ...input.regime,
    activeMode: "PAUSE",
    modeMatchesRecommendation: false,
  };
  input.demo.entryDiagnostics.entry.reason = "Sideway is suspected by structure/ADX but no qualified Supply/Demand confirmation exists.";
  const payload = formatPhase7CDecisionMonitorForMt5(buildPhase7CDecisionMonitor(input));
  assert.match(payload, /^entryReason=Bot đang PAUSE; không mở lệnh mới\./m);
  assert.doesNotMatch(payload, /^entryReason=Sideway is suspected/m);
});

test("open managed position exposes broker P/L, actual protection and hold reason", () => {
  const input = fixture();
  input.telemetry.quote = { bid: 2511, ask: 2511.2, spread: 0.2, timestamp: input.now };
  input.telemetry.positions = [{
    ticket: "9001",
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
    openedAt: input.now - 60_000,
  }];
  input.managedStates = {
    TREND: {
      ticket: "9001",
      side: "BUY",
      pattern: "ENGULFING",
      entry: 2500,
      initialVolume: 0.12,
      breakEvenApplied: true,
      partialApplied: true,
    },
    SIDEWAY: null,
  };
  input.audit = [{
    timestamp: input.now - 1_000,
    strategy: "TREND",
    event: "FVG_HOLD_CONFIRMED",
    stage: "MANAGING",
    reason: "FVG_HOLD_CONFIRMED",
    setup: { side: "BUY", pattern: "ENGULFING" },
    management: { ticket: "9001", breakEvenApplied: true, partialApplied: true },
  }, {
    timestamp: input.now - 60_000,
    strategy: "TREND",
    event: "ENTRY_FILLED",
    stage: "FILLED",
    reason: "ENTRY_FILLED",
    setup: { side: "BUY", pattern: "ENGULFING" },
    plan: { entry: 2500, stopLoss: 2494, tp1: 2510 },
    management: { ticket: "9001" },
  }];

  const snapshot = buildPhase7CDecisionMonitor(input);
  assert.equal(snapshot.position.state, "MANAGING");
  assert.equal(snapshot.position.strategy, "TREND");
  assert.equal(snapshot.position.currentPrice, 2511);
  assert.equal(snapshot.position.floatingPnlUsd, 130);
  assert.equal(snapshot.position.tp1, 2510);
  assert.equal(snapshot.position.breakEvenApplied, true);
  assert.equal(snapshot.position.partialApplied, true);
  assert.match(snapshot.position.entryReason, /ENGULFING/);
  assert.equal(
    snapshot.position.holdReasonCode,
    "HOLD_TREND_STRUCTURE_INTACT",
  );
  assert.equal(
    snapshot.position.holdReason,
    "GIỮ LỆNH: Cấu trúc xu hướng M15 vẫn còn hiệu lực; chưa có điều kiện thoát lệnh.",
  );

  const payload = formatPhase7CDecisionMonitorForMt5(snapshot);
  assert.match(payload, /^positionState=MANAGING/m);
  assert.match(payload, /^floatingPnlUsd=130/m);
  assert.match(payload, /^entryReason=ENGULFING/m);
  assert.match(
    payload,
    /^holdReasonCode=HOLD_TREND_STRUCTURE_INTACT$/m,
  );
  assert.ok(
    payload
      .split(/\r?\n/)
      .includes(
        "holdReason=GIỮ LỆNH: Cấu trúc xu hướng M15 vẫn còn hiệu lực; chưa có điều kiện thoát lệnh.",
      ),
  );
});

test("desktop lifecycle validates the selected account mode and all MT5 trading gates", () => {
  const ready = fixture().telemetry;
  ready.health = {
    ...ready.health,
    accountMode: "demo",
    tradingEnabled: true,
    terminalTradeAllowed: true,
    expertTradeAllowed: true,
  };
  assert.doesNotThrow(() => assertPhase7CSelectedAccountReady(ready));

  const real = { ...ready, health: { ...ready.health, accountMode: "real" } };
  assert.throws(() => assertPhase7CSelectedAccountReady(real), /không khớp cấu hình DEMO/);

  const algoOff = { ...ready, health: { ...ready.health, expertTradeAllowed: false } };
  assert.throws(() => assertPhase7CSelectedAccountReady(algoOff), /Algo\/Expert Trading chưa bật/);
});

test("Daily Recovery follows the canonical Phase7C account mode instead of requiring DEMO telemetry", () => {
  const source = fs.readFileSync(
    new URL("../apps/api/src/services/phase7c-daily-recovery-view.service.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /getPhase7CAccountModeState/);
  assert.match(source, /accountModeAllowsBroker/);
  assert.doesNotMatch(source, /telemetry\.health\?\.accountMode\s*!==\s*["']demo["']/);
  assert.match(
    source,
    /accountModeAllowsBroker\(\s*telemetry\.health\?\.accountMode,\s*accountModeState\s*,?\s*\)/s,
  );
  assert.match(source, /MT5_LIVE_READ_ONLY/);
  assert.match(source, /MT5_DEMO_READ_ONLY/);
});
