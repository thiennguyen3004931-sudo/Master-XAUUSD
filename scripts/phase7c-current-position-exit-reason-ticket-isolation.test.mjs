import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPhase7CUiContract,
  formatPhase7CUiContractForMt5,
} from "../apps/api/src/services/phase7c-ui-contract.service.ts";

const CURRENT_TICKET = "222";
const OLD_TICKET = "111";

function snapshot(recentDecisions) {
  return {
    generatedAt: 2_100_000_000_000,
    symbol: "XAUUSD",
    engine: {
      regime: "RANGING",
      confidence: 80,
      recommendedMode: "SIDEWAY",
      reasons: [],
      supplyDemandRange: { lower: 2490, upper: 2520 },
    },
    mode: {
      active: "SIDEWAY",
      effectiveStrategy: "SIDEWAY",
    },
    account: {
      accountMode: "demo",
      reachable: true,
      openXauusdPositions: 1,
    },
    position: {
      state: "MANAGING",
      count: 1,
      strategy: "SIDEWAY",
      ticket: CURRENT_TICKET,
      side: "BUY",
      volume: 0.06,
      entry: 2500,
      stopLoss: 2494,
      tp1: 2510,
      tp2: 2520,
      floatingPnlUsd: 18,
      floatingPnlPercent: 0.18,
      entryReason: "CURRENT_ENTRY_REASON",
      holdReason: "CURRENT_HOLD_REASON",
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
      decisionReason: "",
    },
    entryDiagnostics: {
      trend: null,
      trendError: null,
    },
    recentDecisions,
    safety: {
      accountGuardValid: true,
    },
  };
}

function row(event, reason, ticket) {
  return {
    timestamp: 2_099_999_990_000,
    strategy: "SIDEWAY",
    event,
    stage: "MANAGING",
    reason,
    management: ticket === undefined ? {} : { ticket },
  };
}

function mt5Field(payload, key) {
  const line = payload
    .split("\n")
    .find((candidate) => candidate.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) : undefined;
}

test("current MANAGING exit reasons are isolated to the open MT5 ticket", () => {
  const oldExit = row("REGIME_LEFT_RANGE", "OLD_TICKET_EXIT_REASON", OLD_TICKET);
  const unknownExit = row("POSITION_CLOSED", "UNKNOWN_TICKET_EXIT_REASON", undefined);
  const currentExit = row("TIME_STOP_180M", "CURRENT_TICKET_EXIT_REASON", CURRENT_TICKET);
  const history = [oldExit, unknownExit, currentExit];

  const ui = buildPhase7CUiContract(snapshot(history));
  const mt5 = formatPhase7CUiContractForMt5(ui);

  assert.equal(ui.uiState, "MANAGING");
  assert.equal(ui.position?.ticket, CURRENT_TICKET);
  assert.deepEqual(
    ui.reasons.exit,
    ["CURRENT_TICKET_EXIT_REASON"],
    "historical exit reasons from another or unknown ticket must not describe the current open position",
  );
  assert.equal(mt5Field(mt5, "exitReason1"), "CURRENT_TICKET_EXIT_REASON");
  assert.equal(mt5Field(mt5, "exitReason2"), "n/a");
  assert.equal(mt5Field(mt5, "exitReason3"), "n/a");

  assert.equal(history.length, 3, "decision audit history must remain intact");
  assert.equal(history[0], oldExit);
  assert.equal(history[1], unknownExit);
  assert.equal(history[2], currentExit);
});
