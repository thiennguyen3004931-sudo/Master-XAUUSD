import {
  PHASE7C_PERFORMANCE_CORRELATION_SCHEMA_VERSION,
  summarizePhase7CPerformanceCorrelationRows,
  type Phase7CPerformanceCorrelationBackfill,
  type Phase7CPerformanceCorrelationRow,
  type Phase7CPerformanceCorrelationVerdict,
} from "../contracts/phase7c-performance-correlation.schema";
import { getPhase7CPerformanceIntelligence } from "./phase7c-performance-intelligence.service";

export { PHASE7C_PERFORMANCE_CORRELATION_SCHEMA_VERSION } from "../contracts/phase7c-performance-correlation.schema";

export interface Phase7CPerformanceCorrelationFilters {
  verdict?: Phase7CPerformanceCorrelationVerdict | null;
  strategy?: "TREND" | "SIDEWAY" | null;
  limit?: number;
}

function clampLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 100;
  return Math.min(500, Math.max(1, Math.trunc(value)));
}

function auditRootFromStreams(streams: readonly string[]): string {
  const first = streams[0];
  if (!first) return "phase7c-executors/decision-observability";
  const slash = first.lastIndexOf("/");
  return slash >= 0 ? first.slice(0, slash) : first;
}

function candidatePositionCountOf(
  verdict: Phase7CPerformanceCorrelationVerdict,
): number | null {
  if (verdict === "EXACT") return 1;
  if (verdict === "UNMATCHED") return 0;
  // Existing canonical snapshot proves ambiguity but intentionally does not
  // expose the full component cardinality. Returning null is fail-closed;
  // P2 must never invent a candidate count.
  return null;
}

export async function buildPhase7CPerformanceCorrelationBackfill(
  days = 90,
  symbol = "XAUUSD",
  filters: Phase7CPerformanceCorrelationFilters = {},
): Promise<Phase7CPerformanceCorrelationBackfill> {
  const snapshot = await getPhase7CPerformanceIntelligence(days, symbol);
  const decisionStreams = snapshot.auditSources.map((source) => source.relativePath);
  const decisionAuditRoot = auditRootFromStreams(decisionStreams);

  const allRows: Phase7CPerformanceCorrelationRow[] = snapshot.trades
    .map((trade) => ({
      schemaVersion: PHASE7C_PERFORMANCE_CORRELATION_SCHEMA_VERSION,
      tradeKey: `${snapshot.account.accountMode}:${trade.strategy}:${trade.positionId}:${trade.id}`,
      symbol: trade.symbol,
      accountMode: snapshot.account.accountMode,
      trade: {
        performanceTradeId: trade.id,
        positionId: trade.positionId,
        strategy: trade.strategy as "TREND" | "SIDEWAY",
        side: trade.side,
        volume: trade.volume,
        openedAt: trade.openedAt,
        closedAt: trade.closedAt,
        netPnl: trade.netPnl,
      },
      correlation: {
        verdict: trade.correlation.verdict,
        method: trade.correlation.method,
        evidence: [...trade.correlation.evidence],
        candidatePositionCount: candidatePositionCountOf(trade.correlation.verdict),
      },
      attribution: {
        entryType: trade.attribution.entryType,
        regime: trade.attribution.regime,
        passedRules: [...trade.attribution.passedRules],
        blockedRules: [...trade.attribution.blockedRules],
        decisionEventIds: [...trade.attribution.decisionEventIds],
      },
      source: {
        accounting: "MT5_ACCOUNT_READ_ONLY" as const,
        decisionAuditRoot,
        decisionStreams: [...decisionStreams],
      },
    }))
    .sort((left, right) => right.trade.closedAt - left.trade.closedAt);

  const verdict = filters.verdict ?? null;
  const strategy = filters.strategy ?? null;
  const limit = clampLimit(filters.limit);
  const filteredRows = allRows.filter((row) => {
    if (verdict && row.correlation.verdict !== verdict) return false;
    if (strategy && row.trade.strategy !== strategy) return false;
    return true;
  });
  const rows = filteredRows.slice(0, limit);
  const summary = summarizePhase7CPerformanceCorrelationRows(allRows);

  return {
    schemaVersion: PHASE7C_PERFORMANCE_CORRELATION_SCHEMA_VERSION,
    generatedAt: snapshot.generatedAt,
    symbol: snapshot.symbol,
    days: snapshot.days,
    accountMode: snapshot.account.accountMode,
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
    },
    summary: {
      ...summary,
      returnedRows: rows.length,
    },
    filters: {
      verdict,
      strategy,
      limit,
    },
    rows,
    notes: [
      "Backfill is reconstructed on demand from current MT5_ACCOUNT_READ_ONLY history plus persisted Phase7C decision audits.",
      "EXACT attribution uses explicit identity evidence already proven by Performance Intelligence; no timestamp or price proximity matching is introduced.",
      "AMBIGUOUS and UNMATCHED rows remain fail-closed. Historical evidence gaps are preserved rather than inferred.",
      "candidatePositionCount is null for AMBIGUOUS rows because the existing canonical snapshot proves ambiguity without exposing a trustworthy full component cardinality.",
      "This service performs no runtime, strategy, risk, order, position, mode, ARM, or AUTO mutation.",
    ],
  };
}
