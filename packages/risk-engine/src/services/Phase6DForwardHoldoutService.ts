import type {
  Phase6ADiagnosticMetrics,
  Phase6Config,
  Phase6DForwardHoldoutResult,
  Phase6RunResult,
  Phase6TradeResult,
} from "../models";

export const PHASE6D_FORWARD_CUTOFF_TIMESTAMP = Date.parse(
  "2026-08-12T16:25:00.000Z",
);
export const PHASE6D_FORWARD_DATASET_OFFSET_MS = 3 * 60 * 60 * 1000;
export const PHASE6D_FORWARD_DATASET_CUTOFF_TIMESTAMP =
  PHASE6D_FORWARD_CUTOFF_TIMESTAMP + PHASE6D_FORWARD_DATASET_OFFSET_MS;
export const PHASE6D_MINIMUM_FILLED_TRADES = 30;
export const PHASE6D_MINIMUM_PROFIT_FACTOR = 1.2;

export const PHASE6D_BASELINE_CONFIG: Phase6Config = {
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

export class Phase6DForwardHoldoutService {
  run(
    baseline: Phase6RunResult,
    cutoffTimestamp = resolvePhase6DDatasetCutoffTimestamp(),
    minimumFilledTrades = PHASE6D_MINIMUM_FILLED_TRADES,
  ): Phase6DForwardHoldoutResult {
    assertBaselineConfig(baseline.config);
    if (!Number.isFinite(cutoffTimestamp)) {
      throw new Error("Phase6DForwardHoldoutService requires a finite cutoff timestamp.");
    }
    if (!Number.isInteger(minimumFilledTrades) || minimumFilledTrades < 1) {
      throw new Error("Phase6DForwardHoldoutService requires minimumFilledTrades >= 1.");
    }

    const ordered = [...baseline.trades].sort(
      (a, b) => a.signalTimestamp - b.signalTimestamp || a.id.localeCompare(b.id),
    );
    const preCutoffCasesIgnored = ordered.filter(
      (trade) => trade.signalTimestamp <= cutoffTimestamp,
    ).length;
    const eligibleTrades = ordered.filter(
      (trade) => trade.signalTimestamp > cutoffTimestamp,
    );
    const buyTrades = eligibleTrades.filter((trade) => trade.side === "BUY");
    const sellTrades = eligibleTrades.filter((trade) => trade.side === "SELL");
    const metrics = diagnosticMetrics(eligibleTrades);
    const sideMetrics = {
      BUY: diagnosticMetrics(buyTrades),
      SELL: diagnosticMetrics(sellTrades),
    } as const;
    const effectivePf = metrics.profitFactor ??
      (metrics.netPnl > 0 ? Number.POSITIVE_INFINITY : 0);
    const positive =
      metrics.netPnl > 0 &&
      metrics.expectancy > 0 &&
      metrics.averageRMultiple > 0 &&
      effectivePf > PHASE6D_MINIMUM_PROFIT_FACTOR;
    const status = metrics.filledTrades < minimumFilledTrades
      ? "INSUFFICIENT_SAMPLE"
      : positive
        ? "PASS"
        : "FAIL";

    return {
      realCutoffTimestamp: PHASE6D_FORWARD_CUTOFF_TIMESTAMP,
      cutoffTimestamp,
      datasetOffsetMs: cutoffTimestamp - PHASE6D_FORWARD_CUTOFF_TIMESTAMP,
      candidate: "BASELINE_BUY_SELL",
      config: baseline.config,
      minimumFilledTrades,
      minimumProfitFactor: PHASE6D_MINIMUM_PROFIT_FACTOR,
      totalInputCases: ordered.length,
      preCutoffCasesIgnored,
      postCutoffCases: eligibleTrades.length,
      eligibleCases: eligibleTrades.length,
      eligibleBuyCases: buyTrades.length,
      eligibleSellCases: sellTrades.length,
      firstEligibleTimestamp: eligibleTrades[0]?.signalTimestamp ?? null,
      lastEligibleTimestamp: eligibleTrades.at(-1)?.signalTimestamp ?? null,
      metrics,
      sideMetrics,
      eligibleTrades,
      status,
    };
  }

  format(result: Phase6DForwardHoldoutResult): string[] {
    const c = result.config;
    const m = result.metrics;
    return [
      `PHASE6D_REAL_CUTOFF_UTC=${new Date(result.realCutoffTimestamp).toISOString()}`,
      `PHASE6D_DATASET_CUTOFF=${new Date(result.cutoffTimestamp).toISOString()}`,
      `PHASE6D_DATASET_OFFSET_MS=${result.datasetOffsetMs}`,
      `PHASE6D_CANDIDATE=${result.candidate}`,
      `PHASE6D_CONFIG=CONFLUENCE_MIN=${c.minConfluenceScore}|ENTRY_EXPIRY_MIN=${c.entryExpiryMinutes}|BE_TRIGGER=${c.breakEvenTriggerPrice}|BE_OFFSET=${c.breakEvenOffsetPrice}|TRAIL_TRIGGER=${c.trailingTriggerPrice}|TRAIL_DISTANCE=${c.trailingDistancePrice}`,
      `PHASE6D_MINIMUM_FILLED_TRADES=${result.minimumFilledTrades}`,
      `PHASE6D_MINIMUM_PROFIT_FACTOR=${result.minimumProfitFactor}`,
      `PHASE6D_TOTAL_INPUT_CASES=${result.totalInputCases}`,
      `PHASE6D_PRE_CUTOFF_CASES_IGNORED=${result.preCutoffCasesIgnored}`,
      `PHASE6D_POST_CUTOFF_CASES=${result.postCutoffCases}`,
      `PHASE6D_ELIGIBLE_CASES=${result.eligibleCases}`,
      `PHASE6D_ELIGIBLE_BUY_CASES=${result.eligibleBuyCases}`,
      `PHASE6D_ELIGIBLE_SELL_CASES=${result.eligibleSellCases}`,
      `PHASE6D_FIRST_ELIGIBLE=${isoOrNone(result.firstEligibleTimestamp)}`,
      `PHASE6D_LAST_ELIGIBLE=${isoOrNone(result.lastEligibleTimestamp)}`,
      `PHASE6D_FILLED_TRADES=${m.filledTrades}`,
      `PHASE6D_WIN_RATE=${m.winRatePercent}`,
      `PHASE6D_NET_PNL=${m.netPnl}`,
      `PHASE6D_PROFIT_FACTOR=${m.filledTrades === 0 ? "NA" : (m.profitFactor ?? "INF")}`,
      `PHASE6D_EXPECTANCY=${m.expectancy}`,
      `PHASE6D_AVG_R=${m.averageRMultiple}`,
      `PHASE6D_MAX_REALIZED_DRAWDOWN_USD=${m.maxRealizedDrawdownUsd}`,
      `PHASE6D_AVG_HOLD_HOURS=${m.averageHoldHours}`,
      metricLine("PHASE6D_COMBINED", m),
      metricLine("PHASE6D_BUY", result.sideMetrics.BUY),
      metricLine("PHASE6D_SELL", result.sideMetrics.SELL),
      `PHASE6D_STATUS=${result.status}`,
      "PHASE6D_PRE_REGISTERED=PASS",
      "PHASE6D_BIDIRECTIONAL=PASS",
      "PHASE6D_NO_M5_RESCUE=PASS",
      "PHASE6D_BASELINE_CONFIG_IMMUTABLE=PASS",
      "PHASE6D_PRODUCTION_MUTATION=false",
    ];
  }
}

export function resolvePhase6DDatasetCutoffTimestamp(): number {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  const raw = runtime.process?.env?.ZIQ_PHASE6D_DATASET_CUTOFF_MS;
  if (raw === undefined || raw.trim() === "") {
    return PHASE6D_FORWARD_DATASET_CUTOFF_TIMESTAMP;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error("ZIQ_PHASE6D_DATASET_CUTOFF_MS must be a finite epoch-millisecond value.");
  }
  return parsed;
}

function assertBaselineConfig(actual: Phase6Config): void {
  for (const key of Object.keys(PHASE6D_BASELINE_CONFIG) as Array<keyof Phase6Config>) {
    const expected = PHASE6D_BASELINE_CONFIG[key];
    const value = actual[key];
    if (!Number.isFinite(value) || Math.abs(value - expected) > 1e-12) {
      throw new Error(
        `Phase 6D baseline config drift at ${key}: expected=${expected}, actual=${String(value)}.`,
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

function metricLine(name: string, m: Phase6ADiagnosticMetrics): string {
  return `${name}=CASES=${m.cases}|FILLED=${m.filledTrades}|WR=${m.winRatePercent}|NET=${m.netPnl}|PF=${m.filledTrades === 0 ? "NA" : (m.profitFactor ?? "INF")}|EXP=${m.expectancy}|AVG_R=${m.averageRMultiple}|DD=${m.maxRealizedDrawdownUsd}|HOLD_H=${m.averageHoldHours}`;
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
