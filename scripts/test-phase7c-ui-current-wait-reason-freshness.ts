import { buildPhase7CUiContract } from "../apps/api/src/services/phase7c-ui-contract.service.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Current wait reasons share the decision monitor's 30-minute freshness boundary.
const THIRTY_MINUTES_MS = 30 * 60_000;
const NOW = 2_000_000_000_000;

function snapshot(recentDecisions: any[]) {
  return {
    generatedAt: NOW,
    symbol: "XAUUSD",
    engine: {
      regime: "RANGING",
      confidence: 80,
      recommendedMode: "SIDEWAY",
      reasons: [],
      supplyDemandRange: null,
    },
    mode: {
      active: "AUTO",
      effectiveStrategy: "SIDEWAY",
    },
    account: {
      accountMode: "real",
      reachable: true,
      openXauusdPositions: 0,
    },
    position: {
      state: "FLAT",
      count: 0,
      strategy: null,
      ticket: null,
      side: null,
      volume: null,
      entry: null,
      stopLoss: null,
      tp1: null,
      tp2: null,
      floatingPnlUsd: null,
      floatingPnlPercent: null,
      entryReason: "",
      holdReason: "",
    },
    lotSettings: {
      restartRequired: false,
    },
    preTrade: {
      strategy: "SIDEWAY",
      stage: "WAITING",
      approved: false,
      side: null,
      setup: null,
      entry: null,
      stopLoss: null,
      tp1: null,
      tp2: null,
      finalLot: null,
      estimatedRiskPercent: null,
      decisionReason: "CURRENT_PRETRADE_REASON",
    },
    entryDiagnostics: {
      trend: null,
      trendError: null,
    },
    recentDecisions,
    safety: {
      accountGuardValid: true,
    },
  } as any;
}

function modeBlock(strategy: "TREND" | "SIDEWAY", ageMs: number, reasonCode: string) {
  return {
    timestamp: NOW - ageMs,
    strategy,
    event: "ENTRY_MODE_BLOCK",
    stage: "BLOCKED",
    reasonCode,
    reason: reasonCode,
  };
}

const staleTrend = modeBlock("TREND", THIRTY_MINUTES_MS + 1, "STALE_TREND_MODE_BLOCK");
const staleSideway = modeBlock("SIDEWAY", THIRTY_MINUTES_MS + 1, "STALE_SIDEWAY_MODE_BLOCK");
const staleHistory = [staleTrend, staleSideway];
const staleUi = buildPhase7CUiContract(snapshot(staleHistory));

assert(
  !staleUi.reasons.trendWait.some((reason) => reason.includes("mode hiện tại chưa cho phép Trend")),
  "TREND: ENTRY_MODE_BLOCK older than 30 minutes must not remain a current wait reason",
);
assert(
  !staleUi.reasons.sidewayWait.some((reason) => reason.includes("mode/AUTO gate hiện tại chưa cho phép Sideway")),
  "SIDEWAY: ENTRY_MODE_BLOCK older than 30 minutes must not remain a current wait reason",
);
assert(staleHistory.length === 2, "audit history must not be deleted or mutated by UI contract filtering");
assert(staleHistory[0] === staleTrend && staleHistory[1] === staleSideway, "audit history identity/order must remain intact");
assert(
  staleUi.reasons.sidewayWait.some((reason) => reason.includes("CURRENT_PRETRADE_REASON")),
  "current non-history wait reasons must remain intact",
);

const boundaryUi = buildPhase7CUiContract(snapshot([
  modeBlock("TREND", THIRTY_MINUTES_MS, "BOUNDARY_TREND_MODE_BLOCK"),
  modeBlock("SIDEWAY", THIRTY_MINUTES_MS, "BOUNDARY_SIDEWAY_MODE_BLOCK"),
]));
assert(
  boundaryUi.reasons.trendWait.some((reason) => reason.includes("mode hiện tại chưa cho phép Trend")),
  "TREND: ENTRY_MODE_BLOCK exactly 30 minutes old must remain current",
);
assert(
  boundaryUi.reasons.sidewayWait.some((reason) => reason.includes("mode/AUTO gate hiện tại chưa cho phép Sideway")),
  "SIDEWAY: ENTRY_MODE_BLOCK exactly 30 minutes old must remain current",
);

console.log("PHASE7C_UI_CURRENT_WAIT_REASON_FRESHNESS_TEST=PASS");
