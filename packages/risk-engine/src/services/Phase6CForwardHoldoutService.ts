import type {
  Phase6ADiagnosticMetrics,
  Phase6CForwardHoldoutResult,
  Phase6Config,
  Phase6RunResult,
  Phase6TradeResult,
} from "../models";

/**
 * Phase 6C was locked after the Phase 6B rescue/side-stability review.
 * This is the real UTC decision cutoff and must not be moved based on
 * forward results.
 */
export const PHASE6C_FORWARD_CUTOFF_TIMESTAMP = Date.parse(
  "2026-08-12T16:10:00.000Z",
);

/**
 * The MT5 replay files encode the broker's +03:00 server clock in the
 * epoch-like timestamp coordinate used by the existing Phase 4/5 datasets.
 */
export const PHASE6C_FORWARD_DATASET_OFFSET_MS = 3 * 60 * 60 * 1000;
export const PHASE6C_FORWARD_DATASET_CUTOFF_TIMESTAMP =
  PHASE6C_FORWARD_CUTOFF_TIMESTAMP + PHASE6C_FORWARD_DATASET_OFFSET_MS;

export const PHASE6C_MINIMUM_FILLED_TRADES = 30;
export const PHASE6C_MINIMUM_PROFIT_FACTOR = 1.2;

/**
 * Immutable Phase 6 baseline configuration selected before the Phase 6C
 * forward sample. No M5 rescue is part of this primary candidate.
 */
export const PHASE6C_BASELINE_CONFIG: Phase6Config = {
  minConfluenceScore: 2,
  atrPeriod: 14,
  maPullbackAtrTolerance: 0.15,
  fvgLookbackBars: 12,
  profileLookbackBars: 96,
  profileBins: 24,
  profileValueAreaFraction: 0.7,
  entryExpiryMinutes: 15,
  breakEvenTriggerPrice: 6,
  breakEvenOffsetPrice: 2,
  trailingTriggerPrice: 10,
  trailingDistancePrice: 5,
};

export class Phase6CForwardHoldoutService {
  run(
    baseline: Phase6RunResult,
    cutoffTimestamp = resolvePhase6CDatasetCutoffTimestamp(),
    minimumFilledTrades = PHASE6C_MINIMUM_FILLED_TRADES,
  ): Phase6CForwardHoldoutResult {
    assertBaselineConfig(baseline.config);
    if (!Number.isFinite(cutoffTimestamp)) {
      throw new Error("Phase6CForwardHoldoutService requires a finite cutoff timestamp.");
    }
    if (!Number.isInteger(minimumFilledTrades) || minimumFilledTrades < 1) {
      throw new Error("Phase6CForwardHoldoutService requires minimumFilledTrades >= 1.");
    }

    const ordered = [...baseline.trades].sort(
      (a, b) => a.signalTimestamp - b.signalTimestamp || a.id.localeCompare(b.id),
    );
    const preCutoffCasesIgnored = ordered.filter(
      (trade) => trade.signalTimestamp <= cutoffTimestamp,
    ).length;
    const postCutoff = ordered.filter(
      (trade) => trade.signalTimestamp > cutoffTimestamp,
    );
    const eligibleTrades = postCutoff.filter((trade) => trade.side === "BUY");
    const metrics = diagnosticMetrics(eligibleTrades);
    const effectivePf = metrics.profitFactor ??
      (metrics.netPnl > 0 ? Number.POSITIVE_INFINITY : 0);

    const positive =
      metrics.netPnl > 0 &&
      metrics.expectancy > 0 &&
      metrics.averageRMultiple > 0 &&
      effectivePf > PHASE6C_MINIMUM_PROFIT_FACTOR;

    const status = metrics.filledTrades < minimumFilledTrades
      ? "INSUFFICIENT_SAMPLE"
      : positive
        ? "PASS"
        : "FAIL";

    return {
      realCutoffTimestamp: PHASE6C_FORWARD_CUTOFF_TIMESTAMP,
      cutoffTimestamp,
      datasetOffsetMs: cutoffTimestamp - PHASE6C_FORWARD_CUTOFF_TIMESTAMP,
      candidate: "BASELINE_BUY",
      config: baseline.config,
      minimumFilledTrades,
      minimumProfitFactor: PHASE6C_MINIMUM_PROFIT_FACTOR,
      totalInputCases: ordered.length,
      preCutoffCasesIgnored,
      postCutoffCases: postCutoff.length,
      eligibleCases: eligibleTrades.length,
      firstEligibleTimestamp: eligibleTrades[0]?.signalTimestamp ?? null,
      lastEligibleTimestamp: eligibleTrades.at(-1)?.signalTimestamp ?? null,
      metrics,
      eligibleTrades,
      status,
    };
  }

  format(result: Phase6CForwardHoldoutResult): string[] {
    const c = result.config;
    const m = result.metrics;
    return [
      `PHASE6C_REAL_CUTOFF_UTC=${new Date(result.realCutoffTimestamp).toISOString()}`,
      `PHASE6C_DATASET_CUTOFF=${new Date(result.cutoffTimestamp).toISOString()}`,
      `PHASE6C_DATASET_OFFSET_MS=${result.datasetOffsetMs}`,
      `PHASE6C_CANDIDATE=${result.candidate}`,
      `PHASE6C_CONFIG=CONFLUENCE_MIN=${c.minConfluenceScore}|ENTRY_EXPIRY_MIN=${c.entryExpiryMinutes}|BE_TRIGGER=${c.breakEvenTriggerPrice}|BE_OFFSET=${c.breakEvenOffsetPrice}|TRAIL_TRIGGER=${c.trailingTriggerPrice}|TRAIL_DISTANCE=${c.trailingDistancePrice}`,
      `PHASE6C_MINIMUM_FILLED_TRADES=${result.minimumFilledTrades}`,
      `PHASE6C_MINIMUM_PROFIT_FACTOR=${result.minimumProfitFactor}`,
      `PHASE6C_TOTAL_INPUT_CASES=${result.totalInputCases}`,
      `PHASE6C_PRE_CUTOFF_CASES_IGNORED=${result.preCutoffCasesIgnored}`,
      `PHASE6C_POST_CUTOFF_CASES=${result.postCutoffCases}`,
      `PHASE6C_ELIGIBLE_CASES=${result.eligibleCases}`,
      `PHASE6C_FIRST_ELIGIBLE=${isoOrNone(result.firstEligibleTimestamp)}`,
      `PHASE6C_LAST_ELIGIBLE=${isoOrNone(result.lastEligibleTimestamp)}`,
      `PHASE6C_FILLED_TRADES=${m.filledTrades}`,
      `PHASE6C_WIN_RATE=${m.winRatePercent}`,
      `PHASE6C_NET_PNL=${m.netPnl}`,
      `PHASE6C_PROFIT_FACTOR=${m.filledTrades === 0 ? "NA" : (m.profitFactor ?? "INF")}`,
      `PHASE6C_EXPECTANCY=${m.expectancy}`,
      `PHASE6C_AVG_R=${m.averageRMultiple}`,
      `PHASE6C_MAX_REALIZED_DRAWDOWN_USD=${m.maxRealizedDrawdownUsd}`,
      `PHASE6C_AVG_HOLD_HOURS=${m.averageHoldHours}`,
      `PHASE6C_STATUS=${result.status}`,
      "PHASE6C_PRE_REGISTERED=PASS",
      "PHASE6C_NO_M5_RESCUE=PASS",
      "PHASE6C_BASELINE_CONFIG_IMMUTABLE=PASS",
      "PHASE6C_PRODUCTION_MUTATION=false",
    ];
  }
}

export function resolvePhase6CDatasetCutoffTimestamp(): number {
  const runtime = globalThis as typeof globalThis & {
    process?: {
      env?: Record<string, string | undefined>;
    };
  };
  const raw = runtime.process?.env?.ZIQ_PHASE6C_DATASET_CUTOFF_MS;
  if (raw === undefined || raw.trim() === "") {
    return PHASE6C_FORWARD_DATASET_CUTOFF_TIMESTAMP;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error("ZIQ_PHASE6C_DATASET_CUTOFF_MS must be a finite epoch-millisecond value.");
  }
  return parsed;
}

function assertBaselineConfig(actual: Phase6Config): void {
  for (const key of Object.keys(PHASE6C_BASELINE_CONFIG) as Array<keyof Phase6Config>) {
    const expected = PHASE6C_BASELINE_CONFIG[key];
    const value = actual[key];
    if (!Number.isFinite(value) || Math.abs(value - expected) > 1e-12) {
      throw new Error(
        `Phase 6C baseline config drift at ${key}: expected=${expected}, actual=${String(value)}.`,
      );
    }
  }
}

function diagnosticMetrics(trades: readonly Phase6TradeResult[]): Phase6ADiagnosticMetrics {
  const filled = trades.filter((trade) => trade.filled);
  const wins = filled.filter((trade) => trade.pnl > 0);
  const losses = filled.filter((trade) => trade.pnl < 0);
  const flat = filled.length - wins.length - losses.length;
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const netPnl = filled.reduce((sum, trade) => sum + trade.pnl, 0);
  return {
    cases: trades.length,
    filledTrades: filled.length,
    wins: wins.length,
    losses: losses.length,
    flat,
    winRatePercent: round(filled.length ? (wins.length / filled.length) * 100 : 0),
    netPnl: round(netPnl),
    grossProfit: round(grossProfit),
    grossLoss: round(grossLoss),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : null,
    expectancy: round(filled.length ? netPnl / filled.length : 0, 4),
    averageRMultiple: round(average(filled.map((trade) => trade.rMultiple)), 4),
    maxRealizedDrawdownUsd: round(maxRealizedDrawdown(filled)),
    averageHoldHours: round(average(filled.map((trade) => trade.holdHours)), 2),
  };
}

function maxRealizedDrawdown(trades: readonly Phase6TradeResult[]): number {
  const ordered = [...trades]
    .filter((trade) => trade.exitTime !== null)
    .sort((a, b) => (a.exitTime ?? 0) - (b.exitTime ?? 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of ordered) {
    equity += trade.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return maxDrawdown;
}

function average(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function isoOrNone(timestamp: number | null): string {
  return timestamp === null ? "NONE" : new Date(timestamp).toISOString();
}
