import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPhase7CDecisionMonitor,
  formatPhase7CDecisionMonitorForMt5,
} from "../apps/api/src/services/phase7c-decision-monitor.service.ts";

const HOLD = Object.freeze({
  TREND: Object.freeze({
    code: "HOLD_TREND_STRUCTURE_INTACT",
    message:
      "GIỮ LỆNH: Cấu trúc xu hướng M15 vẫn còn hiệu lực; chưa có điều kiện thoát lệnh.",
  }),

  SIDEWAY: Object.freeze({
    code: "HOLD_SIDEWAY_RANGE_VALID",
    message:
      "GIỮ LỆNH: Biên sideway vẫn còn hiệu lực; tiếp tục giữ đến TP2 hoặc khi có điều kiện thoát.",
  }),

  RECOVERY: Object.freeze({
    code: "HOLD_RECOVERY_TP_ACTIVE",
    message:
      "GIỮ LỆNH: Recovery TP đang hoạt động; giữ toàn bộ vị thế đến Adaptive TP hoặc SL/BE.",
  }),
});

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
        pattern: {
          matched: true,
          name: "ENGULFING",
          side: "BUY",
        },
        trend: {
          confidenceScore: 80,
          confidenceLevel: "RẤT_CAO",
        },
        entry: {
          eligible: true,
          side: "BUY",
          referenceEntry: 2500,
          structuralStopDistance: 5,
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
        accountBalance: 10000,
        accountCurrency: "USD",
        timestamp: 1,
      },

      quote: {
        bid: 2511,
        ask: 2511.2,
        spread: 0.2,
        timestamp: 1_776_000_002_000,
      },

      spec: {
        cashPerPriceUnitPerLot: 100,
      },

      positions: [],

      checkedAt: 1,
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
    now: 1_776_000_002_000,

    ...overrides,
  };
}

function managedFixture(
  strategy,
  {
    ticket = "9001",
    dailyMode = null,
  } = {},
) {
  const input = fixture();

  input.telemetry.positions = [{
    ticket,
    symbol: "XAUUSD",
    brokerSymbol: "XAUUSD",
    side: "LONG",
    volume: 0.08,
    entry: 2500,
    stopLoss: 2500,
    takeProfit: strategy === "SIDEWAY" ? 2515 : 0,
    profit: 131.5,
    swap: -1,
    commission: -0.5,
    openedAt: input.now - 60_000,
  }];

  const managed = {
    ticket,
    side: "BUY",
    pattern: "ENGULFING",
    entry: 2500,
    initialVolume: 0.12,
    stopLoss: 2494,
    tp1: 2510,
    tp2: strategy === "SIDEWAY" ? 2515 : null,
    dailyMode,
    breakEvenApplied: true,
    partialApplied: true,
    openedAt: input.now - 60_000,
  };

  input.managedStates = {
    TREND: strategy === "TREND" ? managed : null,
    SIDEWAY: strategy === "SIDEWAY" ? managed : null,
  };

  /*
   * Keep a legacy management event deliberately.
   *
   * The new contract requires the backend canonical HOLD resolver
   * to be authoritative instead of recreating a different sentence
   * from the latest journal event.
   */
  input.audit = [{
    timestamp: input.now - 1_000,
    strategy,
    event: "FVG_HOLD_CONFIRMED",
    stage: "MANAGING",
    reasonCode: "LEGACY_DYNAMIC_HOLD",
    reason: "LEGACY_DYNAMIC_HOLD",
    setup: {
      side: "BUY",
      pattern: "ENGULFING",
    },
    management: {
      ticket,
      breakEvenApplied: true,
      partialApplied: true,
    },
  }, {
    timestamp: input.now - 60_000,
    strategy,
    event: "ENTRY_FILLED",
    stage: "FILLED",
    reasonCode: "ENTRY_FILLED",
    reason: "ENTRY_FILLED",
    setup: {
      side: "BUY",
      pattern: "ENGULFING",
    },
    plan: {
      entry: 2500,
      stopLoss: 2494,
      tp1: 2510,
      tp2: strategy === "SIDEWAY" ? 2515 : null,
      dailyMode,
    },
    management: {
      ticket,
    },
  }];

  return input;
}

test(
  "Trend HOLD exposes the exact canonical reasonCode",
  () => {
    const snapshot =
      buildPhase7CDecisionMonitor(
        managedFixture("TREND"),
      );

    assert.equal(
      snapshot.position.holdReasonCode,
      HOLD.TREND.code,
    );
  },
);

test(
  "Trend HOLD exposes the exact canonical Vietnamese message",
  () => {
    const snapshot =
      buildPhase7CDecisionMonitor(
        managedFixture("TREND"),
      );

    assert.equal(
      snapshot.position.holdReason,
      HOLD.TREND.message,
    );
  },
);

test(
  "Sideway HOLD exposes the exact canonical reasonCode and message",
  () => {
    const snapshot =
      buildPhase7CDecisionMonitor(
        managedFixture("SIDEWAY"),
      );

    assert.equal(
      snapshot.position.holdReasonCode,
      HOLD.SIDEWAY.code,
    );

    assert.equal(
      snapshot.position.holdReason,
      HOLD.SIDEWAY.message,
    );
  },
);

test(
  "Recovery TP overrides normal Trend HOLD",
  () => {
    const snapshot =
      buildPhase7CDecisionMonitor(
        managedFixture(
          "TREND",
          { dailyMode: "RECOVERY_TP" },
        ),
      );

    assert.equal(
      snapshot.position.holdReasonCode,
      HOLD.RECOVERY.code,
    );

    assert.equal(
      snapshot.position.holdReason,
      HOLD.RECOVERY.message,
    );
  },
);

test(
  "Recovery TP overrides normal Sideway HOLD",
  () => {
    const snapshot =
      buildPhase7CDecisionMonitor(
        managedFixture(
          "SIDEWAY",
          { dailyMode: "RECOVERY_TP" },
        ),
      );

    assert.equal(
      snapshot.position.holdReasonCode,
      HOLD.RECOVERY.code,
    );

    assert.equal(
      snapshot.position.holdReason,
      HOLD.RECOVERY.message,
    );
  },
);

test(
  "MT5 receives canonical HOLD reasonCode and Vietnamese text unchanged",
  () => {
    const snapshot =
      buildPhase7CDecisionMonitor(
        managedFixture("TREND"),
      );

    const payload =
      formatPhase7CDecisionMonitorForMt5(snapshot);

    const lines =
      new Set(payload.split(/\r?\n/));

    assert.equal(
      lines.has(
        `holdReasonCode=${HOLD.TREND.code}`,
      ),
      true,
    );

    assert.equal(
      lines.has(
        `holdReason=${HOLD.TREND.message}`,
      ),
      true,
    );
  },
);

test(
  "canonical HOLD observability never grants MT5 order permission",
  () => {
    const snapshot =
      buildPhase7CDecisionMonitor(
        managedFixture(
          "TREND",
          { dailyMode: "RECOVERY_TP" },
        ),
      );

    const payload =
      formatPhase7CDecisionMonitorForMt5(snapshot);

    assert.equal(
      snapshot.safety.mt5PanelOrderPermission,
      "NONE",
    );

    assert.match(
      payload,
      /^mt5OrderPermission=NONE$/m,
    );
  },
);