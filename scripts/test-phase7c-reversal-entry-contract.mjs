import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAutoTrendEntryModeGate } from "./phase7c-trend-mode-gate.mjs";

function regime(overrides = {}) {
  return {
    activeMode: "AUTO",
    recommendedMode: "PAUSE",
    regime: "REVERSAL",
    confidence: 78,
    reversal: {
      direction: "BEARISH",
      side: "SELL",
      timestamp: 1_000,
      level: 4300,
    },
    ...overrides,
  };
}

function demo({
  side = "SELL",
  closeTime = 2_000,
  eligible = false,
  reversalEligible = true,
  structuralStopDistance = 8,
} = {}) {
  return {
    entryDiagnostics: {
      closeTime,
      pattern: {
        matched: true,
        side,
        name: "ENGULFING",
      },
      trend: {
        m15Supertrend: side === "SELL" ? "BUY" : "SELL",
        m5Supertrend: side === "SELL" ? "BUY" : "SELL",
      },
      entry: {
        eligible,
        reversalEligible,
        side,
        structuralStopDistance,
        stopDistance: structuralStopDistance < 6 ? 6 : structuralStopDistance,
        action: "ENTRY_IMMEDIATE",
      },
    },
  };
}

test("AUTO REVERSAL allows CHOCH-direction entry without SuperTrend alignment", () => {
  const result = evaluateAutoTrendEntryModeGate({
    activeMode: "AUTO",
    regime: regime(),
    demo: demo({
      side: "SELL",
      eligible: false,
      reversalEligible: true,
    }),
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "AUTO_REVERSAL_CHOCH_DIRECTION_ENTRY");
  assert.equal(result.reversalSide, "SELL");
  assert.equal(result.reversalTimestamp, 1_000);
});

test("AUTO REVERSAL stays fail-closed even if recommendedMode is stale TREND", () => {
  const result = evaluateAutoTrendEntryModeGate({
    activeMode: "AUTO",
    regime: regime({ recommendedMode: "TREND" }),
    demo: demo({
      side: "BUY",
      eligible: true,
      reversalEligible: true,
    }),
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "REVERSAL_DIRECTION_MISMATCH");
});

test("AUTO REVERSAL blocks a signal that continues the old trend", () => {
  const result = evaluateAutoTrendEntryModeGate({
    activeMode: "AUTO",
    regime: regime(),
    demo: demo({
      side: "BUY",
      eligible: true,
      reversalEligible: true,
    }),
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "REVERSAL_DIRECTION_MISMATCH");
});

test("AUTO REVERSAL requires the signal to be strictly newer than CHOCH", () => {
  const sameCandle = evaluateAutoTrendEntryModeGate({
    activeMode: "AUTO",
    regime: regime(),
    demo: demo({
      side: "SELL",
      closeTime: 1_000,
      eligible: true,
      reversalEligible: true,
    }),
  });

  assert.equal(sameCandle.allowed, false);
  assert.equal(sameCandle.reason, "REVERSAL_SIGNAL_NOT_AFTER_CHOCH");

  const older = evaluateAutoTrendEntryModeGate({
    activeMode: "AUTO",
    regime: regime(),
    demo: demo({
      side: "SELL",
      closeTime: 999,
      eligible: true,
      reversalEligible: true,
    }),
  });

  assert.equal(older.allowed, false);
  assert.equal(older.reason, "REVERSAL_SIGNAL_NOT_AFTER_CHOCH");
});

test("AUTO REVERSAL fails closed when canonical CHOCH direction metadata is missing", () => {
  const result = evaluateAutoTrendEntryModeGate({
    activeMode: "AUTO",
    regime: regime({ reversal: null }),
    demo: demo({
      side: "SELL",
      eligible: true,
      reversalEligible: true,
    }),
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "REVERSAL_CONTEXT_MISSING");
});

test("AUTO REVERSAL requires pattern plus valid structure and SL at most 10", () => {
  const tooWide = evaluateAutoTrendEntryModeGate({
    activeMode: "AUTO",
    regime: regime(),
    demo: demo({
      side: "SELL",
      eligible: false,
      reversalEligible: false,
      structuralStopDistance: 10.01,
    }),
  });

  assert.equal(tooWide.allowed, false);
  assert.equal(tooWide.reason, "REVERSAL_ENTRY_CONDITIONS_NOT_READY");
});

test("TRENDING/BREAKOUT continuation behavior remains unchanged", () => {
  const result = evaluateAutoTrendEntryModeGate({
    activeMode: "AUTO",
    regime: {
      activeMode: "AUTO",
      recommendedMode: "TREND",
      regime: "TRENDING",
      confidence: 80,
    },
    demo: demo({
      side: "BUY",
      eligible: false,
      reversalEligible: false,
    }),
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "AUTO_REGIME_ALLOWS_TREND");
});

import fs from "node:fs";

const liveRegimeSource = fs.readFileSync("apps/api/src/services/phase7c-live-regime.service.ts", "utf8");
const diagnosticsSource = fs.readFileSync("apps/api/src/routes/phase7b-demo.route.ts", "utf8");
const trendRuntimeSource = fs.readFileSync("scripts/run-phase7b-demo-controller.ts", "utf8");
const trendWrapperSource = fs.readFileSync("scripts/run-phase7c-trend-controller.mjs", "utf8");
const trendModeGateDeclaration = fs.readFileSync("scripts/phase7c-trend-mode-gate.d.mts", "utf8");

test("shared Trend mode gate keeps a TypeScript declaration for API consumers", () => {
  assert.match(trendModeGateDeclaration, /export function evaluateAutoTrendEntryModeGate/);
  assert.match(trendModeGateDeclaration, /allowed: boolean/);
  assert.match(trendModeGateDeclaration, /reason: string/);
  assert.match(trendModeGateDeclaration, /detail: string/);
});

test("live regime exposes latest confirmed CHOCH direction as canonical reversal side", () => {
  assert.match(liveRegimeSource, /latestConfirmedChoch/);
  assert.match(liveRegimeSource, /event\.confirmed && event\.type === "CHOCH"/);
  assert.match(liveRegimeSource, /direction: latestConfirmedChoch\.direction/);
  assert.match(liveRegimeSource, /side: reversalSide/);
  assert.match(liveRegimeSource, /timestamp: latestConfirmedChoch\.timestamp/);
});

test("read-only diagnostics expose reversal readiness without changing continuation eligibility", () => {
  assert.match(diagnosticsSource, /reversalEligible: boolean/);
  assert.match(diagnosticsSource, /reversalRule: "PATTERN_PLUS_VALID_STRUCTURE_NO_SUPERTREND"/);
  assert.match(diagnosticsSource, /const reversalEligible = Boolean\([\s\S]*pattern[\s\S]*validStructure[\s\S]*structuralStopDistance <= 10/);
  assert.match(diagnosticsSource, /const stopDistance = eligible && structuralStopDistance/);
  assert.match(diagnosticsSource, /const reversalStopDistance = reversalEligible && structuralStopDistance/);
  assert.match(diagnosticsSource, /reversalAction:/);
  assert.match(diagnosticsSource, /reversalReason/);
  assert.match(diagnosticsSource, /SuperTrend M15\/M5 chỉ quan sát và không chặn entry/);
});

test("Trend runtime ignores SuperTrend only inside canonical AUTO REVERSAL context", () => {
  assert.match(trendWrapperSource, /ZIQ_PHASE7C_REVERSAL_ENTRY_ENABLED = "true"/);
  assert.match(trendRuntimeSource, /activeMode !== "AUTO" \|\| regime !== "REVERSAL"/);
  assert.match(trendRuntimeSource, /REVERSAL_CONTEXT_MISSING_OR_INVALID/);
  assert.match(trendRuntimeSource, /REVERSAL_DIRECTION_MISMATCH/);
  assert.match(trendRuntimeSource, /REVERSAL_SIGNAL_NOT_AFTER_CHOCH/);
  assert.match(trendRuntimeSource, /supertrendM15: false/);
  assert.match(trendRuntimeSource, /supertrendM5: false/);
  assert.match(trendRuntimeSource, /validTrendStructure: true/);
  assert.match(trendRuntimeSource, /supertrendGate: activeReversalContext \? "IGNORED_REVERSAL" : "REQUIRED"/);
  assert.match(trendRuntimeSource, /REVERSAL_PULLBACK_CONTEXT_INVALIDATED/);
  assert.match(trendWrapperSource, /reversalOrderGateDiagnostics\(request\?\.body\)/);
  assert.ok(
    trendWrapperSource.includes('const match = /^p7b-(rv-)?(?:pb|im)-(\\d+)-(BUY|SELL)$/.exec(clientOrderId);'),
    "final REVERSAL gate must require explicit rv order provenance",
  );
  assert.match(trendWrapperSource, /reversalOrigin && activeMode !== "AUTO"/);
  assert.match(trendWrapperSource, /REVERSAL_CONTEXT_CHANGED_BEFORE_SUBMIT/);
  assert.match(trendRuntimeSource, /p7b-rv-/);
  assert.match(trendWrapperSource, /idempotencyKey === clientOrderId/);
  assert.match(trendWrapperSource, /structuralStopDistance \+ 1e-9 >= 6/);
  assert.match(trendWrapperSource, /structuralStopDistance <= 10 \+ 1e-9/);
});
