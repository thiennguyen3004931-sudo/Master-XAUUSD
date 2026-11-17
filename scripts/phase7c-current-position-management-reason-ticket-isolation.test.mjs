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
      stopLoss: 2500,
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

function row(event, ticket) {
  return {
    timestamp: 2_099_999_990_000,
    strategy: "SIDEWAY",
    event,
    stage: "MANAGING",
    reason: event,
    management: ticket === undefined ? {} : { ticket },
  };
}

function mt5Field(payload, key) {
  const line = payload
    .split("\n")
    .find((candidate) => candidate.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) : undefined;
}

test("current MANAGING stop/partial reasons reject another or unknown MT5 ticket", () => {
  const oldStop = row("PLUS6_SL_TO_ENTRY", OLD_TICKET);
  const unknownStop = row("PLUS6_SL_TO_ENTRY", undefined);
  const oldPartial = row("PLUS10_PARTIAL_ONE_THIRD", OLD_TICKET);
  const unknownPartial = row("PLUS10_PARTIAL_ONE_THIRD", undefined);
  const history = [oldStop, unknownStop, oldPartial, unknownPartial];

  const ui = buildPhase7CUiContract(snapshot(history));
  const mt5 = formatPhase7CUiContractForMt5(ui);

  assert.equal(ui.uiState, "MANAGING");
  assert.equal(ui.position?.ticket, CURRENT_TICKET);
  assert.deepEqual(
    ui.reasons.stopMove,
    [],
    "DỜI SL must not be attributed to the current position from another or unknown ticket",
  );
  assert.deepEqual(
    ui.reasons.partial,
    [],
    "CHỐT 1/3 must not be attributed to the current position from another or unknown ticket",
  );
  assert.equal(mt5Field(mt5, "stopMoveReason1"), "n/a");
  assert.equal(mt5Field(mt5, "partialReason1"), "n/a");

  assert.equal(history.length, 4, "decision audit history must remain intact");
  assert.equal(history[0], oldStop);
  assert.equal(history[1], unknownStop);
  assert.equal(history[2], oldPartial);
  assert.equal(history[3], unknownPartial);
});

test("current MANAGING stop/partial reasons keep events for the open MT5 ticket", () => {
  const currentStop = row("PLUS6_SL_TO_ENTRY", CURRENT_TICKET);
  const currentPartial = row("PLUS10_PARTIAL_ONE_THIRD", CURRENT_TICKET);
  const ui = buildPhase7CUiContract(snapshot([currentStop, currentPartial]));
  const mt5 = formatPhase7CUiContractForMt5(ui);

  assert.deepEqual(ui.reasons.stopMove, ["SL đã được dời về Entry/BE khi lệnh đạt +6 giá."]);
  assert.deepEqual(ui.reasons.partial, ["Đã chốt đúng 1/3 vị thế khi giá đạt mốc +10."]);
  assert.equal(mt5Field(mt5, "stopMoveReason1"), "SL đã được dời về Entry/BE khi lệnh đạt +6 giá.");
  assert.equal(mt5Field(mt5, "partialReason1"), "Đã chốt đúng 1/3 vị thế khi giá đạt mốc +10.");
});
