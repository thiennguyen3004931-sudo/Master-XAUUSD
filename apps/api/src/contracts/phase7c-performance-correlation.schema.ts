export const PHASE7C_PERFORMANCE_CORRELATION_SCHEMA_VERSION =
  "phase7c-performance-correlation-v1" as const;

export type Phase7CPerformanceCorrelationVerdict =
  | "EXACT"
  | "AMBIGUOUS"
  | "UNMATCHED";

export type Phase7CPerformanceCorrelationMethod =
  | "EXPLICIT_IDENTITY_GRAPH"
  | "NONE";

export type Phase7CPerformanceCorrelationEntryType =
  | "IMMEDIATE"
  | "PULLBACK"
  | "RECOVERY"
  | "UNKNOWN";

export interface Phase7CPerformanceCorrelationRow {
  schemaVersion: typeof PHASE7C_PERFORMANCE_CORRELATION_SCHEMA_VERSION;
  tradeKey: string;
  symbol: string;
  accountMode: "DEMO" | "LIVE";
  trade: {
    performanceTradeId: string;
    positionId: string;
    strategy: "TREND" | "SIDEWAY";
    side: "BUY" | "SELL";
    volume: number;
    openedAt: number;
    closedAt: number;
    netPnl: number;
  };
  correlation: {
    verdict: Phase7CPerformanceCorrelationVerdict;
    method: Phase7CPerformanceCorrelationMethod;
    evidence: string[];
    candidatePositionCount: number | null;
  };
  attribution: {
    entryType: Phase7CPerformanceCorrelationEntryType;
    regime: string | null;
    passedRules: string[];
    blockedRules: string[];
    decisionEventIds: string[];
  };
  source: {
    accounting: "MT5_ACCOUNT_READ_ONLY";
    decisionAuditRoot: string;
    decisionStreams: string[];
  };
}

export interface Phase7CPerformanceCorrelationSummary {
  totalRows: number;
  exactRows: number;
  ambiguousRows: number;
  unmatchedRows: number;
  exactCoveragePercent: number;
}

export interface Phase7CPerformanceCorrelationBackfill {
  schemaVersion: typeof PHASE7C_PERFORMANCE_CORRELATION_SCHEMA_VERSION;
  generatedAt: number;
  symbol: string;
  days: number;
  accountMode: "DEMO" | "LIVE";
  safety: {
    readOnly: true;
    runtimeMutation: false;
    strategyMutation: false;
    riskMutation: false;
    orderMutation: false;
    positionMutation: false;
    modeMutation: false;
    armMutation: false;
    autoRetune: false;
  };
  summary: Phase7CPerformanceCorrelationSummary & {
    returnedRows: number;
  };
  filters: {
    verdict: Phase7CPerformanceCorrelationVerdict | null;
    strategy: "TREND" | "SIDEWAY" | null;
    limit: number;
  };
  rows: Phase7CPerformanceCorrelationRow[];
  notes: string[];
}

function round(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export function summarizePhase7CPerformanceCorrelationRows(
  rows: readonly Phase7CPerformanceCorrelationRow[],
): Phase7CPerformanceCorrelationSummary {
  const exactRows = rows.filter((row) => row.correlation.verdict === "EXACT").length;
  const ambiguousRows = rows.filter((row) => row.correlation.verdict === "AMBIGUOUS").length;
  const unmatchedRows = rows.filter((row) => row.correlation.verdict === "UNMATCHED").length;
  return {
    totalRows: rows.length,
    exactRows,
    ambiguousRows,
    unmatchedRows,
    exactCoveragePercent: rows.length ? round((exactRows / rows.length) * 100) : 0,
  };
}
