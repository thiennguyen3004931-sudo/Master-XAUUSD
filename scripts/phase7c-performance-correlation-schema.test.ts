import assert from "node:assert/strict";
import {
  PHASE7C_PERFORMANCE_CORRELATION_SCHEMA_VERSION,
  summarizePhase7CPerformanceCorrelationRows,
  type Phase7CPerformanceCorrelationRow,
} from "../apps/api/src/contracts/phase7c-performance-correlation.schema";

function row(
  verdict: Phase7CPerformanceCorrelationRow["correlation"]["verdict"],
  positionId: string,
): Phase7CPerformanceCorrelationRow {
  return {
    schemaVersion: PHASE7C_PERFORMANCE_CORRELATION_SCHEMA_VERSION,
    tradeKey: `LIVE:TREND:${positionId}:mt5-${positionId}`,
    symbol: "XAUUSD",
    accountMode: "LIVE",
    trade: {
      performanceTradeId: `mt5-${positionId}`,
      positionId,
      strategy: "TREND",
      side: "BUY",
      volume: 0.03,
      openedAt: 1,
      closedAt: 2,
      netPnl: 1,
    },
    correlation: {
      verdict,
      method: verdict === "EXACT" ? "EXPLICIT_IDENTITY_GRAPH" : "NONE",
      evidence: verdict === "EXACT" ? [`event:POSITION:positionId=${positionId}`] : [],
      candidatePositionCount: verdict === "EXACT" ? 1 : verdict === "UNMATCHED" ? 0 : null,
    },
    attribution: {
      entryType: verdict === "EXACT" ? "IMMEDIATE" : "UNKNOWN",
      regime: verdict === "EXACT" ? "TREND" : null,
      passedRules: verdict === "EXACT" ? ["RULE_A"] : [],
      blockedRules: [],
      decisionEventIds: verdict === "EXACT" ? ["event"] : [],
    },
    source: {
      accounting: "MT5_ACCOUNT_READ_ONLY",
      decisionAuditRoot: "phase7c-executors/decision-observability/live",
      decisionStreams: [
        "phase7c-executors/decision-observability/live/trend-decisions.jsonl",
        "phase7c-executors/decision-observability/live/sideway-decisions.jsonl",
      ],
    },
  };
}

assert.equal(
  PHASE7C_PERFORMANCE_CORRELATION_SCHEMA_VERSION,
  "phase7c-performance-correlation-v1",
);

const exact = row("EXACT", "101");
const ambiguous = row("AMBIGUOUS", "102");
const unmatched = row("UNMATCHED", "103");
const summary = summarizePhase7CPerformanceCorrelationRows([exact, ambiguous, unmatched]);

assert.deepEqual(summary, {
  totalRows: 3,
  exactRows: 1,
  ambiguousRows: 1,
  unmatchedRows: 1,
  exactCoveragePercent: 33.3,
});
assert.equal(exact.correlation.candidatePositionCount, 1);
assert.equal(ambiguous.correlation.candidatePositionCount, null);
assert.equal(unmatched.correlation.candidatePositionCount, 0);
assert.equal(ambiguous.correlation.method, "NONE");
assert.equal(ambiguous.attribution.entryType, "UNKNOWN");
assert.deepEqual(ambiguous.attribution.passedRules, []);
assert.equal(unmatched.correlation.method, "NONE");
assert.deepEqual(unmatched.correlation.evidence, []);

console.log("P2_PERFORMANCE_CORRELATION_SCHEMA_TEST=PASS");
console.log(`P2_PERFORMANCE_CORRELATION_SCHEMA_VERSION=${PHASE7C_PERFORMANCE_CORRELATION_SCHEMA_VERSION}`);
console.log("P2_PERFORMANCE_CORRELATION_AMBIGUOUS=FAIL_CLOSED");
console.log("P2_PERFORMANCE_CORRELATION_UNMATCHED=FAIL_CLOSED");
