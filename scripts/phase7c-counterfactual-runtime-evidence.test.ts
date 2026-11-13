import assert from "node:assert/strict";
// P6C contract: async provider wiring must preserve management-cycle timing and fail closed.
import {
  PHASE7C_PERFORMANCE_EFFECTIVENESS_SCHEMA_VERSION,
  type Phase7CPerformanceEffectivenessRow,
} from "../apps/api/src/contracts/phase7c-performance-effectiveness.schema";
import {
  buildPhase7CCounterfactualSnapshotFromRowsWithEvidence,
} from "../apps/api/src/services/phase7c-counterfactual-intelligence.service";

function row(): Phase7CPerformanceEffectivenessRow {
  return {
    schemaVersion: PHASE7C_PERFORMANCE_EFFECTIVENESS_SCHEMA_VERSION,
    tradeKey: "LIVE:TREND:123:trade-1",
    positionId: "123",
    symbol: "XAUUSD",
    accountMode: "LIVE",
    strategy: "TREND",
    side: "BUY",
    entryType: "IMMEDIATE",
    regime: "TREND",
    openedAt: 1_000,
    closedAt: 10_000,
    entry: 100,
    exit: 108,
    initialVolume: 0.03,
    netPnl: 8,
    correlation: { verdict: "EXACT", evidence: ["POSITION", "ORDER", "SIGNAL"] },
    rules: { passed: [], blocked: [] },
    excursion: {
      evidence: "COMPLETE_M5_WINDOW",
      initialRiskPrice: 10,
      mfePrice: 20,
      maePrice: 1,
      mfeR: 2,
      maeR: 0.1,
      realizedR: 0.8,
      peakToExitGivebackPrice: 12,
    },
    management: {
      evidence: "EXACT",
      events: [
        {
          family: "FAST_MOVE_TIGHTEN",
          timestamp: 3_000,
          stopLoss: 110,
          price: 120,
          source: "trend-decisions.jsonl",
          eventId: "fm-1",
        },
      ],
    },
    fastMove: {
      current: { activationPrice: 10, givebackPrice: 10, source: "LIVE_BID_ASK" },
      triggered: true,
      handoffToM5: false,
    },
    quality: {
      exactCorrelation: true,
      completeExcursionEvidence: true,
      exactManagementEvidence: true,
      warnings: [],
    },
  };
}

async function main() {
  let exactProviderCalls = 0;
  const exact = await buildPhase7CCounterfactualSnapshotFromRowsWithEvidence({
    rows: [row()],
    generatedAt: 55_555,
    evidenceProvider: async (inputRow) => {
      exactProviderCalls += 1;
      assert.equal(inputRow.positionId, "123");
      return {
        verdict: "EXACT_PATH" as const,
        complete: true,
        managementSamples: [
          { timestamp: 1_000, price: 100, sequence: 0 },
          { timestamp: 2_000, price: 112, sequence: 1 },
          { timestamp: 3_000, price: 120, sequence: 2 },
          { timestamp: 10_000, price: 108, sequence: 3 },
        ],
        brokerTicks: [
          { timestamp: 1_000, sequence: 0, bid: 100, ask: 100.2, price: 100 },
          { timestamp: 2_000, sequence: 1, bid: 112, ask: 112.2, price: 112 },
          { timestamp: 2_500, sequence: 2, bid: 110, ask: 110.2, price: 110 },
          { timestamp: 3_000, sequence: 3, bid: 120, ask: 120.2, price: 120 },
          { timestamp: 3_100, sequence: 4, bid: 113.5, ask: 113.7, price: 113.5 },
          { timestamp: 10_000, sequence: 5, bid: 108, ask: 108.2, price: 108 },
        ],
        warnings: [],
      };
    },
  });

  assert.equal(exactProviderCalls, 1);
  const exactFastMove = exact.scenarios.filter((scenario) => scenario.family === "FAST_MOVE_GIVEBACK");
  assert.equal(exactFastMove.length, 4);
  assert.equal(exactFastMove.every((scenario) => scenario.evidence.verdict === "EXACT"), true);
  assert.equal(
    exactFastMove.every((scenario) =>
      scenario.evidence.sources.includes("MANAGEMENT_SAMPLES_PLUS_BROKER_TICKS_COMPLETE")),
    true,
  );
  assert.equal(exact.summary.exactCount >= 4, true);

  let unavailableProviderCalls = 0;
  const bounded = await buildPhase7CCounterfactualSnapshotFromRowsWithEvidence({
    rows: [row()],
    generatedAt: 66_666,
    evidenceProvider: async () => {
      unavailableProviderCalls += 1;
      return {
        verdict: "UNAVAILABLE" as const,
        complete: false,
        managementSamples: [],
        brokerTicks: [],
        warnings: ["BROKER_TICK_PATH_UNAVAILABLE"],
      };
    },
  });

  assert.equal(unavailableProviderCalls, 1);
  const boundedFastMove = bounded.scenarios.filter((scenario) => scenario.family === "FAST_MOVE_GIVEBACK");
  assert.equal(boundedFastMove.length, 4);
  assert.equal(boundedFastMove.every((scenario) => scenario.evidence.verdict === "BOUNDED"), true);
  assert.equal(bounded.summary.exactCount, 0);

  console.log("P6C_RUNTIME_EVIDENCE_WIRING_TEST=PASS");
  console.log("P6C_P4_EXACT_PATH_RUNTIME_PROVIDER=PASS");
  console.log("P6C_FAIL_CLOSED_TO_BOUNDED=PASS");

}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
