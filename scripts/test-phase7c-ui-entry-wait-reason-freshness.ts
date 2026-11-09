import { buildPhase7CUiContract } from "../apps/api/src/services/phase7c-ui-contract.service.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const THIRTY_MINUTES_MS = 30 * 60_000;
const NOW = 2_100_000_000_000;

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

function decision(
  strategy: "TREND" | "SIDEWAY",
  event: string,
  ageMs: number,
  reason: string,
) {
  return {
    timestamp: NOW - ageMs,
    strategy,
    event,
    stage: "BLOCKED",
    reasonCode: reason,
    reason,
  };
}

const staleSideway = decision(
  "SIDEWAY",
  "ENTRY_LOCATION_BLOCK",
  THIRTY_MINUTES_MS + 1,
  "STALE_SIDEWAY_LOCATION",
);
const staleTrend = decision(
  "TREND",
  "WAIT_PULLBACK",
  THIRTY_MINUTES_MS + 1,
  "STALE_TREND_PULLBACK",
);
const staleHistory = [staleSideway, staleTrend];
const staleUi = buildPhase7CUiContract(snapshot(staleHistory));

assert(
  !staleUi.reasons.sidewayWait.some((reason) => reason.includes("giá chưa ở vùng demand/supply")),
  "SIDEWAY: ENTRY_LOCATION_BLOCK older than 30 minutes must not remain a current wait reason",
);
assert(
  !staleUi.reasons.trendWait.some((reason) => reason.includes("SL cấu trúc đang lớn hơn 10 giá")),
  "TREND: WAIT_PULLBACK older than 30 minutes must not remain a current wait reason",
);
assert(staleHistory.length === 2, "audit history must remain intact");
assert(
  staleHistory[0] === staleSideway && staleHistory[1] === staleTrend,
  "audit history identity/order must remain intact",
);
assert(
  staleUi.reasons.sidewayWait.some((reason) => reason.includes("CURRENT_PRETRADE_REASON")),
  "current pre-trade wait reason must remain visible",
);

const boundaryUi = buildPhase7CUiContract(snapshot([
  decision("SIDEWAY", "ENTRY_LOCATION_BLOCK", THIRTY_MINUTES_MS, "BOUNDARY_SIDEWAY_LOCATION"),
  decision("TREND", "WAIT_PULLBACK", THIRTY_MINUTES_MS, "BOUNDARY_TREND_PULLBACK"),
]));
assert(
  boundaryUi.reasons.sidewayWait.some((reason) => reason.includes("giá chưa ở vùng demand/supply")),
  "SIDEWAY: ENTRY_LOCATION_BLOCK exactly 30 minutes old must remain current",
);
assert(
  boundaryUi.reasons.trendWait.some((reason) => reason.includes("SL cấu trúc đang lớn hơn 10 giá")),
  "TREND: WAIT_PULLBACK exactly 30 minutes old must remain current",
);

console.log("PHASE7C_UI_ENTRY_WAIT_REASON_FRESHNESS_TEST=PASS");
