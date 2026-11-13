import path from "node:path";
import {
  PHASE7C_PERFORMANCE_EFFECTIVENESS_SCHEMA_VERSION,
  type Phase7CPerformanceEffectivenessMetricBucket,
  type Phase7CPerformanceEffectivenessRow,
  type Phase7CPerformanceEffectivenessSnapshot,
  type Phase7CPerformanceExcursion,
  type Phase7CPerformanceStrategy,
} from "../contracts/phase7c-performance-effectiveness.schema";
import { getPhase7CPerformanceIntelligence } from "./phase7c-performance-intelligence.service";
import { getPhase7CManagementEvidence } from "./phase7c-performance-management-evidence.service";
import {
  evaluatePhase7CExcursion,
  type Phase7CExcursionBar,
} from "./phase7c-performance-excursion.service";

export interface Phase7CPerformanceEffectivenessRowsInput {
  rows: readonly Phase7CPerformanceEffectivenessRow[];
  generatedAt?: number;
}

export interface Phase7CPerformanceEffectivenessQuery {
  days?: number;
  symbol?: string;
  limit?: number;
}

type PerformanceIntelligenceSnapshot = Awaited<ReturnType<typeof getPhase7CPerformanceIntelligence>>;
type PerformanceIntelligenceTrade = PerformanceIntelligenceSnapshot["trades"][number];

const M5_MS = 5 * 60_000;

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function isExact(row: Phase7CPerformanceEffectivenessRow): boolean {
  return row.correlation.verdict === "EXACT" && row.quality.exactCorrelation === true;
}

function metricBucket(
  key: string,
  rows: readonly Phase7CPerformanceEffectivenessRow[],
): Phase7CPerformanceEffectivenessMetricBucket {
  const wins = rows.filter((row) => row.netPnl > 0).length;
  const losses = rows.filter((row) => row.netPnl < 0).length;
  const breakeven = rows.length - wins - losses;
  const netPnl = rows.reduce((total, row) => total + Number(row.netPnl || 0), 0);
  const grossProfit = rows.reduce(
    (total, row) => total + Math.max(0, Number(row.netPnl || 0)),
    0,
  );
  const grossLoss = rows.reduce(
    (total, row) => total + Math.abs(Math.min(0, Number(row.netPnl || 0))),
    0,
  );
  return {
    key,
    sampleSize: rows.length,
    wins,
    losses,
    breakeven,
    netPnl: round(netPnl),
    expectancy: rows.length > 0 ? round(netPnl / rows.length) : 0,
    winRatePercent: rows.length > 0 ? round((wins / rows.length) * 100, 1) : 0,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
  };
}

function groupedBuckets(
  rows: readonly Phase7CPerformanceEffectivenessRow[],
  keysOf: (row: Phase7CPerformanceEffectivenessRow) => readonly string[],
): Phase7CPerformanceEffectivenessMetricBucket[] {
  const groups = new Map<string, Phase7CPerformanceEffectivenessRow[]>();
  for (const row of rows) {
    for (const rawKey of new Set(keysOf(row).map((key) => key.trim()).filter(Boolean))) {
      const group = groups.get(rawKey) ?? [];
      group.push(row);
      groups.set(rawKey, group);
    }
  }
  return [...groups.entries()]
    .map(([key, group]) => metricBucket(key, group))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function average(values: readonly (number | null)[]): number | null {
  const finite = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  if (finite.length === 0) return null;
  return round(finite.reduce((total, value) => total + value, 0) / finite.length, 4);
}

function lockedProfitPrice(row: Phase7CPerformanceEffectivenessRow): number | null {
  const candidates = row.management.events
    .filter((event) => event.family === "FAST_MOVE_TIGHTEN")
    .map((event) => event.stopLoss)
    .filter((stopLoss): stopLoss is number => typeof stopLoss === "number" && Number.isFinite(stopLoss))
    .map((stopLoss) => row.side === "BUY" ? stopLoss - row.entry : row.entry - stopLoss)
    .filter((distance) => distance > 0);
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

export function buildPhase7CPerformanceEffectivenessSnapshotFromRows(
  input: Phase7CPerformanceEffectivenessRowsInput,
): Phase7CPerformanceEffectivenessSnapshot {
  const rows = [...input.rows];
  const exactRows = rows.filter(isExact);
  const excursionRows = exactRows.filter(
    (row) =>
      row.quality.completeExcursionEvidence === true &&
      row.excursion.evidence === "COMPLETE_M5_WINDOW",
  );
  const managementRows = exactRows.filter(
    (row) => row.quality.exactManagementEvidence === true && row.management.evidence === "EXACT",
  );

  const managementFamilies = groupedBuckets(
    managementRows,
    (row) => [...new Set(row.management.events.map((event) => event.family))],
  );
  const lockedProfit = exactRows
    .map(lockedProfitPrice)
    .filter((value): value is number => value !== null);

  return {
    schemaVersion: PHASE7C_PERFORMANCE_EFFECTIVENESS_SCHEMA_VERSION,
    generatedAt: Number.isFinite(Number(input.generatedAt)) ? Number(input.generatedAt) : Date.now(),
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
      totalRows: rows.length,
      exactRows: exactRows.length,
      excursionQualifiedRows: excursionRows.length,
      managementQualifiedRows: managementRows.length,
      evidenceCoveragePercent: rows.length > 0
        ? round((exactRows.length / rows.length) * 100, 1)
        : 0,
    },
    aggregates: {
      strategy: groupedBuckets(exactRows, (row) => [row.strategy]),
      entryType: groupedBuckets(exactRows, (row) => [row.entryType]),
      regime: groupedBuckets(exactRows, (row) => [row.regime ?? "UNKNOWN"]),
      rule: groupedBuckets(exactRows, (row) => row.rules.passed),
      management: managementFamilies,
      excursion: {
        sampleSize: excursionRows.length,
        averageMfePrice: average(excursionRows.map((row) => row.excursion.mfePrice)),
        averageMaePrice: average(excursionRows.map((row) => row.excursion.maePrice)),
        averageMfeR: average(excursionRows.map((row) => row.excursion.mfeR)),
        averageMaeR: average(excursionRows.map((row) => row.excursion.maeR)),
        averageRealizedR: average(excursionRows.map((row) => row.excursion.realizedR)),
        averagePeakToExitGivebackPrice: average(
          excursionRows.map((row) => row.excursion.peakToExitGivebackPrice),
        ),
      },
      fastMove: {
        exactSampleSize: exactRows.length,
        triggeredRows: exactRows.filter((row) => row.fastMove.triggered).length,
        handoffRows: exactRows.filter((row) => row.fastMove.handoffToM5).length,
        averageLockedProfitPrice: average(lockedProfit),
      },
    },
    rows,
    notes: [
      "Expectancy, rule, regime, strategy, and management aggregates include EXACT correlation rows only; AMBIGUOUS and UNMATCHED evidence remains fail-closed.",
      "Management buckets describe observed association with realized outcomes; they do not establish causal effectiveness by themselves.",
      "Excursion aggregates include only COMPLETE_M5_WINDOW evidence. R metrics remain null when initial structural risk is not proven.",
      "Fast-Move locked-profit distance is derived only from explicit FAST_MOVE_TIGHTEN stop evidence. Shadow replay remains separate and SHADOW_ONLY.",
      "This snapshot performs no runtime, strategy, risk, order, position, mode, ARM, AUTO, or LIVE-test-order mutation.",
    ],
  };
}

function runtimeRoot(): string {
  const configured = process.env.PHASE7C_RUNTIME_ROOT?.trim();
  if (configured) return path.resolve(configured);
  const demoDir = process.env.PHASE7B_DEMO_WORK_DIR?.trim();
  if (demoDir) return path.resolve(demoDir, "..");
  return path.resolve(process.cwd(), ".runtime");
}

function unavailableExcursion(): Phase7CPerformanceExcursion {
  return {
    evidence: "UNAVAILABLE",
    initialRiskPrice: null,
    mfePrice: null,
    maePrice: null,
    mfeR: null,
    maeR: null,
    realizedR: null,
    peakToExitGivebackPrice: null,
  };
}

async function readHistoricalM5Bars(
  symbol: string,
  openedAt: number,
  closedAt: number,
): Promise<{ bars: Phase7CExcursionBar[]; warning: string | null }> {
  const apiKey = (process.env.MT5_BRIDGE_API_KEY ?? process.env.MT5_API_KEY ?? "").trim();
  if (!apiKey) return { bars: [], warning: "MT5_BRIDGE_API_KEY_MISSING" };
  const base = (process.env.MT5_BRIDGE_BASE_URL ?? "http://127.0.0.1:8765").replace(/\/$/, "");
  const fromMs = Math.max(0, Math.trunc(openedAt - M5_MS));
  const toMs = Math.max(fromMs + 1, Math.trunc(closedAt + M5_MS));
  const params = new URLSearchParams({
    timeframe: "M5",
    fromMs: String(fromMs),
    toMs: String(toMs),
  });
  try {
    const response = await fetch(
      `${base}/v1/history/candles/${encodeURIComponent(symbol)}?${params.toString()}`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-mt5-api-key": apiKey,
        },
      },
    );
    if (!response.ok) {
      return { bars: [], warning: `M5_HISTORY_HTTP_${response.status}` };
    }
    const payload = await response.json() as unknown;
    if (!Array.isArray(payload)) return { bars: [], warning: "M5_HISTORY_PAYLOAD_INVALID" };
    const bars = payload
      .map((item) => {
        const row = item as Record<string, unknown>;
        return {
          openTime: Number(row.openTime),
          closeTime: Number(row.closeTime),
          high: Number(row.high),
          low: Number(row.low),
        };
      });
    return { bars, warning: null };
  } catch {
    return { bars: [], warning: "M5_HISTORY_UNAVAILABLE" };
  }
}

function fastMoveContract(_strategy: Phase7CPerformanceStrategy) {
  return {
    activationPrice: 10,
    givebackPrice: 10,
    source: "LIVE_BID_ASK" as const,
  };
}

async function effectivenessRow(
  trade: PerformanceIntelligenceTrade,
  accountMode: "DEMO" | "LIVE",
  symbol: string,
): Promise<Phase7CPerformanceEffectivenessRow> {
  const executionStrategy = trade.strategy as "TREND" | "SIDEWAY";
  const strategy = trade.attribution.performanceStrategy as Phase7CPerformanceStrategy;
  const exactCorrelation = trade.correlation.verdict === "EXACT";
  const warnings: string[] = [];

  const management = exactCorrelation
    ? getPhase7CManagementEvidence({
        runtimeRoot: runtimeRoot(),
        accountMode,
        strategy: executionStrategy,
        positionId: trade.positionId,
        openedAt: trade.openedAt,
        closedAt: trade.closedAt,
      })
    : {
        evidence: "UNMATCHED" as const,
        events: [],
        source: { journalPath: "", available: false, parsedRows: 0, malformedRows: 0 },
        warnings: ["CORRELATION_NOT_EXACT"],
      };
  warnings.push(...management.warnings);

  let excursion = unavailableExcursion();
  if (exactCorrelation) {
    const history = await readHistoricalM5Bars(symbol, trade.openedAt, trade.closedAt);
    if (history.warning) warnings.push(history.warning);
    if (history.bars.length > 0) {
      excursion = evaluatePhase7CExcursion({
        side: trade.side,
        entry: trade.entry,
        exit: trade.exit,
        openedAt: trade.openedAt,
        closedAt: trade.closedAt,
        initialRiskPrice: null,
        bars: history.bars,
      });
      if (excursion.evidence !== "COMPLETE_M5_WINDOW") {
        warnings.push(`M5_WINDOW_${excursion.evidence}`);
      }
    }
  } else {
    warnings.push("CORRELATION_NOT_EXACT");
  }

  const fastMoveTriggered = management.events.some(
    (event) => event.family === "FAST_MOVE_TIGHTEN" || event.family === "FAST_MOVE_REJECTED",
  );
  const handoffToM5 = management.events.some(
    (event) => event.family === "FAST_MOVE_HANDOFF_M5_STRUCTURE",
  );

  return {
    schemaVersion: PHASE7C_PERFORMANCE_EFFECTIVENESS_SCHEMA_VERSION,
    tradeKey: `${accountMode}:${strategy}:${trade.positionId}:${trade.id}`,
    positionId: trade.positionId,
    symbol: trade.symbol,
    accountMode,
    strategy,
    side: trade.side,
    entryType: trade.attribution.entryType,
    regime: trade.attribution.regime,
    openedAt: trade.openedAt,
    closedAt: trade.closedAt,
    entry: trade.entry,
    exit: trade.exit,
    initialVolume: trade.volume,
    netPnl: trade.netPnl,
    correlation: {
      verdict: trade.correlation.verdict,
      evidence: [...trade.correlation.evidence],
    },
    rules: {
      passed: [...trade.attribution.passedRules],
      blocked: [...trade.attribution.blockedRules],
    },
    excursion,
    management: {
      evidence: management.evidence,
      events: [...management.events],
    },
    fastMove: {
      current: fastMoveContract(strategy),
      triggered: fastMoveTriggered,
      handoffToM5,
    },
    quality: {
      exactCorrelation,
      completeExcursionEvidence: excursion.evidence === "COMPLETE_M5_WINDOW",
      exactManagementEvidence: management.evidence === "EXACT",
      warnings: [...new Set(warnings)],
    },
  };
}

export async function getPhase7CPerformanceEffectivenessSnapshot(
  query: Phase7CPerformanceEffectivenessQuery = {},
): Promise<Phase7CPerformanceEffectivenessSnapshot> {
  const days = query.days ?? 90;
  const symbol = query.symbol?.trim().toUpperCase() || "XAUUSD";
  const limit = Math.min(200, Math.max(1, Math.trunc(query.limit ?? 100)));
  const intelligence = await getPhase7CPerformanceIntelligence(days, symbol);
  const accountMode = intelligence.account.accountMode;
  const selected = [...intelligence.trades]
    .filter((trade) => trade.strategy === "TREND" || trade.strategy === "SIDEWAY")
    .sort((left, right) => right.closedAt - left.closedAt)
    .slice(0, limit);

  const rows: Phase7CPerformanceEffectivenessRow[] = [];
  for (const trade of selected) {
    rows.push(await effectivenessRow(trade, accountMode, symbol));
  }
  const snapshot = buildPhase7CPerformanceEffectivenessSnapshotFromRows({
    rows,
    generatedAt: intelligence.generatedAt,
  });
  return {
    ...snapshot,
    notes: [
      ...snapshot.notes,
      "TREND, SIDEWAY, and canonical REVERSAL entries are reported as separate performance strategies; REVERSAL keeps the TREND execution journal only for evidence lookup.",
      "M5 excursion data is loaded through the bridge GET-only historical-candles endpoint; unavailable or incomplete windows remain null.",
      "Initial structural risk is not inferred from current accounting history, so production R metrics remain null until exact initial-risk evidence is persisted.",
      "SHADOW_ONLY Fast-Move alternatives are not replayed from M5 OHLC because candle high/low does not prove intrabar price ordering. Ordered bid/ask evidence is required.",
    ],
  };
}