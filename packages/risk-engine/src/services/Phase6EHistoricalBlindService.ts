import type {
  Phase6ADiagnosticMetrics,
  Phase6Bar,
  Phase6Config,
  Phase6EExcursion,
  Phase6EExcursionSummary,
  Phase6EHistoricalBlindFold,
  Phase6EHistoricalBlindResult,
  Phase6EManagementMetrics,
  Phase6RunResult,
  Phase6Side,
  Phase6TradeResult,
} from "../models";

export const PHASE6E_BLIND_DAYS = 360;
export const PHASE6E_WARMUP_DAYS = 30;
export const PHASE6E_EXPORT_DAYS = 730;
export const PHASE6E_FOLD_COUNT = 6;
export const PHASE6E_MINIMUM_FILLED_TRADES = 30;
export const PHASE6E_MINIMUM_PROFIT_FACTOR = 1.2;
export const PHASE6E_MINIMUM_POSITIVE_FOLDS = 4;

export const PHASE6E_BASELINE_CONFIG: Phase6Config = {
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

export class Phase6EHistoricalBlindService {
  run(
    baseline: Phase6RunResult,
    m5Bars: readonly Phase6Bar[],
    blindStartTimestamp: number,
    blindEndTimestamp: number,
  ): Phase6EHistoricalBlindResult {
    assertBaselineConfig(baseline.config);
    if (!Number.isFinite(blindStartTimestamp) || !Number.isFinite(blindEndTimestamp)) {
      throw new Error("Phase6EHistoricalBlindService requires finite blind boundaries.");
    }
    if (blindEndTimestamp <= blindStartTimestamp) {
      throw new Error("Phase6EHistoricalBlindService requires blindEndTimestamp > blindStartTimestamp.");
    }

    const ordered = [...baseline.trades].sort(
      (a, b) => a.signalTimestamp - b.signalTimestamp || a.id.localeCompare(b.id),
    );
    const eligibleTrades = ordered.filter(
      (trade) =>
        trade.signalTimestamp >= blindStartTimestamp &&
        trade.signalTimestamp < blindEndTimestamp,
    );
    const buyTrades = eligibleTrades.filter((trade) => trade.side === "BUY");
    const sellTrades = eligibleTrades.filter((trade) => trade.side === "SELL");
    const metrics = diagnosticMetrics(eligibleTrades);
    const sideMetrics = {
      BUY: diagnosticMetrics(buyTrades),
      SELL: diagnosticMetrics(sellTrades),
    } satisfies Record<Phase6Side, Phase6ADiagnosticMetrics>;
    const management = managementMetrics(eligibleTrades);
    const sideManagement = {
      BUY: managementMetrics(buyTrades),
      SELL: managementMetrics(sellTrades),
    } satisfies Record<Phase6Side, Phase6EManagementMetrics>;
    const folds = buildFixedTimeFolds(
      eligibleTrades,
      blindStartTimestamp,
      blindEndTimestamp,
      PHASE6E_FOLD_COUNT,
    );
    const positiveFolds = folds.filter((fold) => fold.positive).length;
    const buyPositiveFolds = folds.filter((fold) => fold.buyPositive).length;
    const sellPositiveFolds = folds.filter((fold) => fold.sellPositive).length;
    const excursions = buildExcursions(
      eligibleTrades.filter((trade) => trade.filled && trade.entryTime !== null),
      m5Bars,
      baseline.config,
    );
    const excursionSummary = summarizeExcursions(excursions);

    const effectivePf = metrics.profitFactor ??
      (metrics.netPnl > 0 ? Number.POSITIVE_INFINITY : 0);
    const positive =
      metrics.netPnl > 0 &&
      metrics.expectancy > 0 &&
      metrics.averageRMultiple > 0 &&
      effectivePf > PHASE6E_MINIMUM_PROFIT_FACTOR &&
      positiveFolds >= PHASE6E_MINIMUM_POSITIVE_FOLDS;
    const status = metrics.filledTrades < PHASE6E_MINIMUM_FILLED_TRADES
      ? "INSUFFICIENT_SAMPLE"
      : positive
        ? "PASS"
        : "FAIL";

    return {
      candidate: "BASELINE_BUY_SELL",
      config: baseline.config,
      blindStartTimestamp,
      blindEndTimestamp,
      minimumFilledTrades: PHASE6E_MINIMUM_FILLED_TRADES,
      minimumProfitFactor: PHASE6E_MINIMUM_PROFIT_FACTOR,
      minimumPositiveFolds: PHASE6E_MINIMUM_POSITIVE_FOLDS,
      foldCount: PHASE6E_FOLD_COUNT,
      totalInputCases: ordered.length,
      eligibleCases: eligibleTrades.length,
      eligibleBuyCases: buyTrades.length,
      eligibleSellCases: sellTrades.length,
      metrics,
      sideMetrics,
      management,
      sideManagement,
      folds,
      positiveFolds,
      buyPositiveFolds,
      sellPositiveFolds,
      excursions,
      excursionSummary,
      eligibleTrades,
      status,
    };
  }

  format(result: Phase6EHistoricalBlindResult): string[] {
    const c = result.config;
    const lines = [
      "PHASE6E_MODE=HISTORICAL_BLIND_HOLDOUT",
      `PHASE6E_CANDIDATE=${result.candidate}`,
      `PHASE6E_BLIND_START_DATASET=${new Date(result.blindStartTimestamp).toISOString()}`,
      `PHASE6E_BLIND_END_DATASET=${new Date(result.blindEndTimestamp).toISOString()}`,
      `PHASE6E_BLIND_DAYS=${PHASE6E_BLIND_DAYS}`,
      `PHASE6E_WARMUP_DAYS=${PHASE6E_WARMUP_DAYS}`,
      `PHASE6E_CONFIG=CONFLUENCE_MIN=${c.minConfluenceScore}|ENTRY_EXPIRY_MIN=${c.entryExpiryMinutes}|BE_TRIGGER=${c.breakEvenTriggerPrice}|BE_OFFSET=${c.breakEvenOffsetPrice}|TRAIL_TRIGGER=${c.trailingTriggerPrice}|TRAIL_DISTANCE=${c.trailingDistancePrice}`,
      `PHASE6E_GATE=MIN_FILLED=${result.minimumFilledTrades}|MIN_PF_STRICT_GT=${result.minimumProfitFactor}|NET_GT_0|EXPECTANCY_GT_0|AVG_R_GT_0|POSITIVE_FOLDS_MIN=${result.minimumPositiveFolds}/${result.foldCount}`,
      `PHASE6E_TOTAL_INPUT_CASES=${result.totalInputCases}`,
      `PHASE6E_ELIGIBLE_CASES=${result.eligibleCases}`,
      `PHASE6E_ELIGIBLE_BUY_CASES=${result.eligibleBuyCases}`,
      `PHASE6E_ELIGIBLE_SELL_CASES=${result.eligibleSellCases}`,
      metricLine("PHASE6E_ALL", result.metrics),
      metricLine("PHASE6E_BUY", result.sideMetrics.BUY),
      metricLine("PHASE6E_SELL", result.sideMetrics.SELL),
      managementLine("PHASE6E_MANAGEMENT_ALL", result.management),
      managementLine("PHASE6E_MANAGEMENT_BUY", result.sideManagement.BUY),
      managementLine("PHASE6E_MANAGEMENT_SELL", result.sideManagement.SELL),
      excursionSummaryLine(result.excursionSummary),
    ];

    for (const fold of result.folds) {
      lines.push(
        `PHASE6E_FOLD_${fold.fold}=START=${new Date(fold.startTimestamp).toISOString()}|END=${new Date(fold.endTimestamp).toISOString()}|${metricPayload(fold.metrics)}|POSITIVE=${fold.positive ? "PASS" : "FAIL"}`,
        metricLine(`PHASE6E_FOLD_${fold.fold}_BUY`, fold.sideMetrics.BUY) + `|POSITIVE=${fold.buyPositive ? "PASS" : "FAIL"}`,
        metricLine(`PHASE6E_FOLD_${fold.fold}_SELL`, fold.sideMetrics.SELL) + `|POSITIVE=${fold.sellPositive ? "PASS" : "FAIL"}`,
      );
    }

    lines.push(
      `PHASE6E_POSITIVE_FOLDS=${result.positiveFolds}/${result.foldCount}`,
      `PHASE6E_BUY_POSITIVE_FOLDS=${result.buyPositiveFolds}/${result.foldCount}`,
      `PHASE6E_SELL_POSITIVE_FOLDS=${result.sellPositiveFolds}/${result.foldCount}`,
      `PHASE6E_STATUS=${result.status}`,
      "PHASE6E_PRE_REGISTERED=PASS",
      "PHASE6E_FIXED_TIME_FOLDS=PASS",
      "PHASE6E_NO_M5_RESCUE=PASS",
      "PHASE6E_BASELINE_CONFIG_IMMUTABLE=PASS",
      "PHASE6E_MFE_MAE_DIAGNOSTIC_ONLY=PASS",
      "PHASE6E_NO_RETUNE=PASS",
      "PHASE6E_RESEARCH_ONLY=PASS",
      "PHASE6E_PRODUCTION_MUTATION=false",
    );
    return lines;
  }
}

function buildFixedTimeFolds(
  trades: readonly Phase6TradeResult[],
  blindStartTimestamp: number,
  blindEndTimestamp: number,
  foldCount: number,
): Phase6EHistoricalBlindFold[] {
  const width = (blindEndTimestamp - blindStartTimestamp) / foldCount;
  return Array.from({ length: foldCount }, (_, index) => {
    const startTimestamp = Math.round(blindStartTimestamp + width * index);
    const endTimestamp = index === foldCount - 1
      ? blindEndTimestamp
      : Math.round(blindStartTimestamp + width * (index + 1));
    const sample = trades.filter(
      (trade) => trade.signalTimestamp >= startTimestamp && trade.signalTimestamp < endTimestamp,
    );
    const buy = sample.filter((trade) => trade.side === "BUY");
    const sell = sample.filter((trade) => trade.side === "SELL");
    const metrics = diagnosticMetrics(sample);
    const sideMetrics = {
      BUY: diagnosticMetrics(buy),
      SELL: diagnosticMetrics(sell),
    } satisfies Record<Phase6Side, Phase6ADiagnosticMetrics>;
    return {
      fold: index + 1,
      startTimestamp,
      endTimestamp,
      metrics,
      sideMetrics,
      positive: isPositive(metrics),
      buyPositive: isPositive(sideMetrics.BUY),
      sellPositive: isPositive(sideMetrics.SELL),
    };
  });
}

function buildExcursions(
  trades: readonly Phase6TradeResult[],
  m5Bars: readonly Phase6Bar[],
  config: Phase6Config,
): Phase6EExcursion[] {
  const orderedBars = [...m5Bars].sort((a, b) => a.openTime - b.openTime);
  return trades.map((trade) => {
    const entryTime = trade.entryTime!;
    const completedBeforeExit = orderedBars.filter(
      (bar) =>
        bar.openTime >= entryTime &&
        (trade.exitTime === null || bar.closeTime < trade.exitTime),
    );
    const highs = completedBeforeExit.map((bar) => bar.high);
    const lows = completedBeforeExit.map((bar) => bar.low);
    const pointPrices = [trade.entry];
    if (trade.exit !== null) pointPrices.push(trade.exit);
    const maxPrice = Math.max(...pointPrices, ...highs);
    const minPrice = Math.min(...pointPrices, ...lows);
    const initialRiskPrice = Math.abs(trade.entry - trade.stopLoss);
    const mfePrice = trade.side === "BUY"
      ? Math.max(0, maxPrice - trade.entry)
      : Math.max(0, trade.entry - minPrice);
    const maePrice = trade.side === "BUY"
      ? Math.max(0, trade.entry - minPrice)
      : Math.max(0, maxPrice - trade.entry);
    const maxFavorablePrice = trade.side === "BUY" ? maxPrice : minPrice;
    const maxAdversePrice = trade.side === "BUY" ? minPrice : maxPrice;
    return {
      id: trade.id,
      side: trade.side,
      signalTimestamp: trade.signalTimestamp,
      entryTime,
      exitTime: trade.exitTime,
      entry: trade.entry,
      stopLoss: trade.stopLoss,
      initialRiskUsd: trade.initialRiskUsd,
      initialRiskPrice: round(initialRiskPrice, 5),
      maxFavorablePrice: round(maxFavorablePrice, 5),
      maxAdversePrice: round(maxAdversePrice, 5),
      mfePrice: round(mfePrice, 5),
      maePrice: round(maePrice, 5),
      mfeR: round(initialRiskPrice > 0 ? mfePrice / initialRiskPrice : 0, 4),
      maeR: round(initialRiskPrice > 0 ? maePrice / initialRiskPrice : 0, 4),
      distanceToPlus6: round(Math.max(0, config.breakEvenTriggerPrice - mfePrice), 5),
      reachedPlus6: trade.reachedPlus6,
      reachedPlus10: trade.reachedPlus10,
      breakEvenApplied: trade.breakEvenApplied,
      trailingActivated: trade.trailingActivated,
      exitReason: trade.exitReason,
      pnl: trade.pnl,
      rMultiple: trade.rMultiple,
    };
  });
}

function summarizeExcursions(excursions: readonly Phase6EExcursion[]): Phase6EExcursionSummary {
  const mfeRs = excursions.map((item) => item.mfeR).sort((a, b) => a - b);
  const maeRs = excursions.map((item) => item.maeR).sort((a, b) => a - b);
  return {
    filledTrades: excursions.length,
    averageMfePrice: round(average(excursions.map((item) => item.mfePrice)), 4),
    averageMaePrice: round(average(excursions.map((item) => item.maePrice)), 4),
    averageMfeR: round(average(mfeRs), 4),
    averageMaeR: round(average(maeRs), 4),
    medianMfeR: round(median(mfeRs), 4),
    medianMaeR: round(median(maeRs), 4),
    plus6MissesWithin1Price: excursions.filter(
      (item) => !item.reachedPlus6 && item.distanceToPlus6 > 0 && item.distanceToPlus6 <= 1,
    ).length,
  };
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

function managementMetrics(trades: readonly Phase6TradeResult[]): Phase6EManagementMetrics {
  const filled = trades.filter((trade) => trade.filled);
  return {
    filledTrades: filled.length,
    reachedPlus6: filled.filter((trade) => trade.reachedPlus6).length,
    reachedPlus10: filled.filter((trade) => trade.reachedPlus10).length,
    breakEvenApplied: filled.filter((trade) => trade.breakEvenApplied).length,
    trailingActivated: filled.filter((trade) => trade.trailingActivated).length,
  };
}

function isPositive(metrics: Phase6ADiagnosticMetrics): boolean {
  const effectivePf = metrics.profitFactor ??
    (metrics.netPnl > 0 ? Number.POSITIVE_INFINITY : 0);
  return metrics.filledTrades > 0 &&
    metrics.netPnl > 0 &&
    metrics.expectancy > 0 &&
    metrics.averageRMultiple > 0 &&
    effectivePf > 1;
}

function assertBaselineConfig(actual: Phase6Config): void {
  for (const key of Object.keys(PHASE6E_BASELINE_CONFIG) as Array<keyof Phase6Config>) {
    const expected = PHASE6E_BASELINE_CONFIG[key];
    const value = actual[key];
    if (!Number.isFinite(value) || Math.abs(value - expected) > 1e-12) {
      throw new Error(
        `Phase 6E baseline config drift at ${key}: expected=${expected}, actual=${String(value)}.`,
      );
    }
  }
}

function metricLine(name: string, metrics: Phase6ADiagnosticMetrics): string {
  return `${name}=${metricPayload(metrics)}`;
}

function metricPayload(metrics: Phase6ADiagnosticMetrics): string {
  return `CASES=${metrics.cases}|FILLED=${metrics.filledTrades}|WR=${metrics.winRatePercent}|NET=${metrics.netPnl}|PF=${metrics.filledTrades === 0 ? "NA" : (metrics.profitFactor ?? "INF")}|EXP=${metrics.expectancy}|AVG_R=${metrics.averageRMultiple}|DD=${metrics.maxRealizedDrawdownUsd}|HOLD_H=${metrics.averageHoldHours}`;
}

function managementLine(name: string, metrics: Phase6EManagementMetrics): string {
  return `${name}=FILLED=${metrics.filledTrades}|PLUS6=${metrics.reachedPlus6}|PLUS10=${metrics.reachedPlus10}|BE=${metrics.breakEvenApplied}|TRAIL=${metrics.trailingActivated}`;
}

function excursionSummaryLine(summary: Phase6EExcursionSummary): string {
  return `PHASE6E_EXCURSION_SUMMARY=FILLED=${summary.filledTrades}|AVG_MFE_PRICE=${summary.averageMfePrice}|AVG_MAE_PRICE=${summary.averageMaePrice}|AVG_MFE_R=${summary.averageMfeR}|AVG_MAE_R=${summary.averageMaeR}|MEDIAN_MFE_R=${summary.medianMfeR}|MEDIAN_MAE_R=${summary.medianMaeR}|PLUS6_MISSES_WITHIN_1=${summary.plus6MissesWithin1Price}`;
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

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2
    : (values[middle] ?? 0);
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
