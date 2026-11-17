import assert from "node:assert/strict";
import {
  PHASE7C_PERFORMANCE_EFFECTIVENESS_SCHEMA_VERSION,
  type Phase7CPerformanceEffectivenessRow,
  type Phase7CPerformanceEffectivenessSnapshot,
} from "../apps/api/src/contracts/phase7c-performance-effectiveness.schema";

const row: Phase7CPerformanceEffectivenessRow = {
  schemaVersion: PHASE7C_PERFORMANCE_EFFECTIVENESS_SCHEMA_VERSION,
  tradeKey: "LIVE:TREND:101:mt5-101",
  positionId: "101",
  symbol: "XAUUSD",
  accountMode: "LIVE",
  strategy: "TREND",
  side: "BUY",
  entryType: "IMMEDIATE",
  regime: "TREND",
  openedAt: 1_000,
  closedAt: 2_000,
  entry: 4300,
  exit: 4309,
  initialVolume: 0.03,
  netPnl: 9,
  correlation: {
    verdict: "EXACT",
    evidence: ["event:POSITION:positionId=101"],
  },
  rules: {
    passed: ["RULE_A"],
    blocked: [],
  },
  excursion: {
    evidence: "COMPLETE_M5_WINDOW",
    initialRiskPrice: 8,
    mfePrice: 15,
    maePrice: 2,
    mfeR: 1.875,
    maeR: 0.25,
    realizedR: 1.125,
    peakToExitGivebackPrice: 6,
  },
  management: {
    evidence: "EXACT",
    events: [
      {
        family: "FAST_MOVE_TIGHTEN",
        timestamp: 1_500,
        stopLoss: 4304,
        price: 4310,
        source: "phase7b-demo-events.jsonl",
        eventId: "TREND:FAST_MOVE:1",
      },
      {
        family: "FAST_MOVE_HANDOFF_M5_STRUCTURE",
        timestamp: 1_700,
        stopLoss: null,
        price: 4308,
        source: "phase7b-demo-events.jsonl",
        eventId: "TREND:HANDOFF:1",
      },
    ],
  },
  fastMove: {
    current: {
      activationPrice: 10,
      givebackPrice: 6,
      source: "LIVE_BID_ASK",
    },
    triggered: true,
    handoffToM5: true,
  },
  quality: {
    exactCorrelation: true,
    completeExcursionEvidence: true,
    exactManagementEvidence: true,
    warnings: [],
  },
};

const snapshot: Phase7CPerformanceEffectivenessSnapshot = {
  schemaVersion: PHASE7C_PERFORMANCE_EFFECTIVENESS_SCHEMA_VERSION,
  generatedAt: 3_000,
  source: "PHASE7C_PERFORMANCE_EFFECTIVENESS",
  readOnly: true,
  safety: {
    readOnly: true,
    runtimeMutation: false,
    strategyMutation: false,
    riskMutation: false,
    orderMutation: false,
    positionMutation: false,
    modeMutation: false,
    armMutation: false,
    autoRetune: false,
    liveTestOrder: false,
  },
  summary: {
    totalRows: 1,
    exactRows: 1,
    excursionQualifiedRows: 1,
    managementQualifiedRows: 1,
    evidenceCoveragePercent: 100,
  },
  aggregates: {
    strategy: [],
    entryType: [],
    regime: [],
    rule: [],
    management: [],
    excursion: {
      sampleSize: 1,
      averageMfePrice: 15,
      averageMaePrice: 2,
      averageMfeR: 1.875,
      averageMaeR: 0.25,
      averageRealizedR: 1.125,
      averagePeakToExitGivebackPrice: 6,
    },
    fastMove: {
      exactSampleSize: 1,
      triggeredRows: 1,
      handoffRows: 1,
      averageLockedProfitPrice: 4,
    },
  },
  rows: [row],
  notes: [],
};

assert.equal(
  PHASE7C_PERFORMANCE_EFFECTIVENESS_SCHEMA_VERSION,
  "phase7c-performance-effectiveness-v1",
);
assert.equal(snapshot.readOnly, true);
assert.equal(snapshot.safety.strategyMutation, false);
assert.equal(snapshot.safety.orderMutation, false);
assert.equal(snapshot.safety.positionMutation, false);
assert.equal(snapshot.safety.autoRetune, false);
assert.equal(snapshot.rows[0]?.excursion.mfeR, 1.875);
assert.equal(snapshot.rows[0]?.fastMove.current.givebackPrice, 6);
assert.equal(snapshot.rows[0]?.management.events[0]?.family, "FAST_MOVE_TIGHTEN");
assert.equal(snapshot.aggregates.fastMove.averageLockedProfitPrice, 4);
assert.equal("autoApply" in snapshot, false);

console.log("P3_PERFORMANCE_EFFECTIVENESS_SCHEMA_TEST=PASS");
console.log(`P3_PERFORMANCE_EFFECTIVENESS_SCHEMA_VERSION=${PHASE7C_PERFORMANCE_EFFECTIVENESS_SCHEMA_VERSION}`);
console.log("P3_READ_ONLY=TRUE");