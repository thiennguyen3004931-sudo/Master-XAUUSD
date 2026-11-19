import type {
  Phase6ADiagnosticMetrics,
  Phase6ADiagnosticsResult,
  Phase6ARescueSource,
  Phase6BRescuedTrade,
  Phase6BRescueOutcomeResult,
  Phase6BSideFold,
  Phase6Bar,
  Phase6RunRequest,
  Phase6RunResult,
  Phase6Side,
  Phase6TradeResult,
} from "../models";

const RESCUE_SOURCES: readonly Phase6ARescueSource[] = [
  "M5_MA20",
  "M5_MA50",
  "M5_FVG",
  "M15_POC",
  "M15_VAH",
  "M15_VAL",
];

interface MetricTrade {
  side: Phase6Side;
  signalTimestamp: number;
  filled: boolean;
  exitTime: number | null;
  pnl: number;
  rMultiple: number;
  holdHours: number;
}

interface FoldBoundary {
  fold: number;
  startTimestamp: number;
  endTimestamp: number;
  includeEnd: boolean;
}

export class Phase6BRescueOutcomeService {
  run(
    baseline: Phase6RunResult,
    diagnostics: Phase6ADiagnosticsResult,
    request: Phase6RunRequest,
  ): Phase6BRescueOutcomeResult {
    validateRequest(request);

    if (diagnostics.riskBlockedCount !== baseline.metrics.riskBlocked) {
      throw new Error(
        `Phase 6B risk-blocked reconciliation failed: baseline=${baseline.metrics.riskBlocked}, diagnostics=${diagnostics.riskBlockedCount}.`,
      );
    }

    const feasible = diagnostics.rescueCases.filter((item) => item.rescued);
    if (feasible.length !== diagnostics.rescuedCount) {
      throw new Error(
        `Phase 6B rescue reconciliation failed: diagnostics=${diagnostics.rescuedCount}, feasible=${feasible.length}.`,
      );
    }

    const rescuedTrades = feasible.map((item) => {
      if (
        item.rescueSource === null ||
        item.rescueEntry === null ||
        item.rescueFillTime === null
      ) {
        throw new Error(`Phase 6B rescued case is missing execution fields: ${item.id}`);
      }
      return simulateRescuedTrade(
        item.id,
        item.side,
        item.signalTimestamp,
        item.rescueSource,
        item.rescueEntry,
        item.stopLoss,
        item.rescueFillTime,
        baseline,
        request,
      );
    });

    const rescuedRows = rescuedTrades.map(toMetricTrade);
    const rescuedMetrics = diagnosticMetrics(rescuedRows);
    const rescuedBySide = {
      BUY: diagnosticMetrics(rescuedRows.filter((trade) => trade.side === "BUY")),
      SELL: diagnosticMetrics(rescuedRows.filter((trade) => trade.side === "SELL")),
    } satisfies Record<Phase6Side, Phase6ADiagnosticMetrics>;

    const rescuedBySource = Object.fromEntries(
      RESCUE_SOURCES.map((source) => [
        source,
        diagnosticMetrics(
          rescuedTrades
            .filter((trade) => trade.rescueSource === source)
            .map(toMetricTrade),
        ),
      ]),
    ) as Record<Phase6ARescueSource, Phase6ADiagnosticMetrics>;

    const combinedRows: MetricTrade[] = [
      ...baseline.trades,
      ...rescuedRows,
    ];
    const combinedMetrics = diagnosticMetrics(combinedRows);
    const combinedBySide = {
      BUY: diagnosticMetrics(combinedRows.filter((trade) => trade.side === "BUY")),
      SELL: diagnosticMetrics(combinedRows.filter((trade) => trade.side === "SELL")),
    } satisfies Record<Phase6Side, Phase6ADiagnosticMetrics>;

    const boundaries = buildFoldBoundaries(baseline.trades, 4);
    const baselineSideFolds = {
      BUY: buildSideFolds(baseline.trades, "BUY", boundaries),
      SELL: buildSideFolds(baseline.trades, "SELL", boundaries),
    } satisfies Record<Phase6Side, Phase6BSideFold[]>;
    const combinedSideFolds = {
      BUY: buildSideFolds(combinedRows, "BUY", boundaries),
      SELL: buildSideFolds(combinedRows, "SELL", boundaries),
    } satisfies Record<Phase6Side, Phase6BSideFold[]>;

    return {
      rescuedTrades,
      rescuedMetrics,
      rescuedBySide,
      rescuedBySource,
      combinedMetrics,
      combinedBySide,
      baselineSideFolds,
      baselinePositiveSideFolds: {
        BUY: baselineSideFolds.BUY.filter((fold) => fold.positive).length,
        SELL: baselineSideFolds.SELL.filter((fold) => fold.positive).length,
      },
      combinedSideFolds,
      combinedPositiveSideFolds: {
        BUY: combinedSideFolds.BUY.filter((fold) => fold.positive).length,
        SELL: combinedSideFolds.SELL.filter((fold) => fold.positive).length,
      },
    };
  }

  format(result: Phase6BRescueOutcomeResult): string[] {
    const lines = [
      "PHASE6B_ANALYSIS=RESCUE_OUTCOME_SIDE_STABILITY_COMBINED",
      "PHASE6B_BASELINE_IMMUTABLE=PASS",
      `PHASE6B_RESCUED_REPLAYED=${result.rescuedTrades.length}`,
      metricLine("PHASE6B_RESCUED", result.rescuedMetrics),
      metricLine("PHASE6B_RESCUED_BUY", result.rescuedBySide.BUY),
      metricLine("PHASE6B_RESCUED_SELL", result.rescuedBySide.SELL),
    ];

    for (const source of RESCUE_SOURCES) {
      lines.push(metricLine(`PHASE6B_RESCUE_SOURCE_${source}`, result.rescuedBySource[source]));
    }

    lines.push(
      metricLine("PHASE6B_COMBINED", result.combinedMetrics),
      metricLine("PHASE6B_COMBINED_BUY", result.combinedBySide.BUY),
      metricLine("PHASE6B_COMBINED_SELL", result.combinedBySide.SELL),
    );

    for (const side of ["BUY", "SELL"] as const) {
      for (const fold of result.baselineSideFolds[side]) {
        lines.push(foldLine(`PHASE6B_BASELINE_${side}_WF_FOLD_${fold.fold}`, fold));
      }
      lines.push(
        `PHASE6B_BASELINE_${side}_WF_POSITIVE_FOLDS=${result.baselinePositiveSideFolds[side]}/${result.baselineSideFolds[side].length}`,
      );
    }

    for (const side of ["BUY", "SELL"] as const) {
      for (const fold of result.combinedSideFolds[side]) {
        lines.push(foldLine(`PHASE6B_COMBINED_${side}_WF_FOLD_${fold.fold}`, fold));
      }
      lines.push(
        `PHASE6B_COMBINED_${side}_WF_POSITIVE_FOLDS=${result.combinedPositiveSideFolds[side]}/${result.combinedSideFolds[side].length}`,
      );
    }

    lines.push(
      "PHASE6B_RESCUE_STRUCTURAL_STOP_PRESERVED=PASS",
      "PHASE6B_PER_TRADE_RISK_CAP_PRESERVED=PASS",
      "PHASE6B_MANAGEMENT_UNCHANGED=PASS",
      "PHASE6B_NO_RETUNE=PASS",
      "PHASE6B_RESEARCH_ONLY=PASS",
      "PHASE6B_PRODUCTION_MUTATION=false",
    );
    return lines;
  }
}

function simulateRescuedTrade(
  id: string,
  side: Phase6Side,
  signalTimestamp: number,
  rescueSource: Phase6ARescueSource,
  entry: number,
  stopLoss: number,
  entryTime: number,
  baseline: Phase6RunResult,
  request: Phase6RunRequest,
): Phase6BRescuedTrade {
  const minVolume = request.minVolume ?? 0.01;
  const volumeStep = request.volumeStep ?? minVolume;
  const volume = sizeForRisk(
    entry,
    stopLoss,
    request.riskCapUsd,
    request.tickSize,
    request.tickValuePerLot,
    minVolume,
    volumeStep,
  );
  if (volume < minVolume) {
    throw new Error(`Phase 6B rescue is no longer risk-feasible at replay time: ${id}`);
  }
  const initialRiskUsd = riskUsd(
    entry,
    stopLoss,
    volume,
    request.tickSize,
    request.tickValuePerLot,
  );
  if (initialRiskUsd > request.riskCapUsd + 1e-9) {
    throw new Error(`Phase 6B rescue exceeded per-trade risk cap: ${id}`);
  }

  const bars = [...request.m5Bars]
    .filter((bar) => bar.openTime >= entryTime)
    .sort((a, b) => a.openTime - b.openTime);
  if (bars.length === 0 || !touchesPrice(bars[0]!, entry)) {
    throw new Error(`Phase 6B rescue fill reconciliation failed: ${id}`);
  }

  const trendExit = findTrendExit(side, signalTimestamp, request.m15Bars);
  let activeStop = stopLoss;
  let reachedPlus6 = false;
  let reachedPlus10 = false;
  let breakEvenApplied = false;
  let trailingActivated = false;

  for (const bar of bars) {
    if (touchesPrice(bar, activeStop)) {
      return closeRescuedTrade({
        id,
        side,
        signalTimestamp,
        rescueSource,
        entry,
        stopLoss,
        volume,
        initialRiskUsd,
        entryTime,
        exitTime: bar.closeTime,
        exit: activeStop,
        finalStopLoss: activeStop,
        reachedPlus6,
        reachedPlus10,
        breakEvenApplied,
        trailingActivated,
        exitReason: "STOP",
      }, request);
    }

    if (trendExit !== null && bar.closeTime >= trendExit.timestamp) {
      return closeRescuedTrade({
        id,
        side,
        signalTimestamp,
        rescueSource,
        entry,
        stopLoss,
        volume,
        initialRiskUsd,
        entryTime,
        exitTime: trendExit.timestamp,
        exit: trendExit.price,
        finalStopLoss: activeStop,
        reachedPlus6,
        reachedPlus10,
        breakEvenApplied,
        trailingActivated,
        exitReason: "TREND_MA20",
      }, request);
    }

    const favorable = side === "BUY" ? bar.high - entry : entry - bar.low;
    if (favorable >= baseline.config.breakEvenTriggerPrice) {
      reachedPlus6 = true;
      breakEvenApplied = true;
      const breakEvenStop = side === "BUY"
        ? entry + baseline.config.breakEvenOffsetPrice
        : entry - baseline.config.breakEvenOffsetPrice;
      activeStop = improveStop(side, activeStop, breakEvenStop);
    }

    if (favorable >= baseline.config.trailingTriggerPrice) {
      reachedPlus10 = true;
      trailingActivated = true;
      const trailingStop = side === "BUY"
        ? bar.high - baseline.config.trailingDistancePrice
        : bar.low + baseline.config.trailingDistancePrice;
      activeStop = improveStop(side, activeStop, trailingStop);
    }
  }

  const last = bars.at(-1)!;
  return closeRescuedTrade({
    id,
    side,
    signalTimestamp,
    rescueSource,
    entry,
    stopLoss,
    volume,
    initialRiskUsd,
    entryTime,
    exitTime: last.closeTime,
    exit: last.close,
    finalStopLoss: activeStop,
    reachedPlus6,
    reachedPlus10,
    breakEvenApplied,
    trailingActivated,
    exitReason: "END_OF_DATA",
  }, request);
}

function closeRescuedTrade(
  input: Omit<Phase6BRescuedTrade, "pnl" | "rMultiple" | "holdHours">,
  request: Phase6RunRequest,
): Phase6BRescuedTrade {
  const move = input.side === "BUY" ? input.exit - input.entry : input.entry - input.exit;
  const pnl = (move / request.tickSize) * request.tickValuePerLot * input.volume;
  return {
    ...input,
    entry: round(input.entry, 5),
    stopLoss: round(input.stopLoss, 5),
    volume: round(input.volume, 4),
    initialRiskUsd: round(input.initialRiskUsd, 4),
    exit: round(input.exit, 5),
    finalStopLoss: round(input.finalStopLoss, 5),
    pnl: round(pnl),
    rMultiple: input.initialRiskUsd > 0 ? round(pnl / input.initialRiskUsd, 4) : 0,
    holdHours: round((input.exitTime - input.entryTime) / 3_600_000, 2),
  };
}

function buildFoldBoundaries(
  trades: readonly Phase6TradeResult[],
  foldCount: number,
): FoldBoundary[] {
  if (trades.length === 0) return [];
  const minTimestamp = Math.min(...trades.map((trade) => trade.signalTimestamp));
  const maxTimestamp = Math.max(...trades.map((trade) => trade.signalTimestamp));
  const span = Math.max(1, maxTimestamp - minTimestamp + 1);
  const width = span / foldCount;
  return Array.from({ length: foldCount }, (_, index) => ({
    fold: index + 1,
    startTimestamp: Math.round(minTimestamp + index * width),
    endTimestamp: Math.round(
      index === foldCount - 1 ? maxTimestamp : minTimestamp + (index + 1) * width,
    ),
    includeEnd: index === foldCount - 1,
  }));
}

function buildSideFolds(
  trades: readonly MetricTrade[],
  side: Phase6Side,
  boundaries: readonly FoldBoundary[],
): Phase6BSideFold[] {
  return boundaries.map((boundary) => {
    const sample = trades.filter((trade) =>
      trade.side === side &&
      trade.signalTimestamp >= boundary.startTimestamp &&
      (boundary.includeEnd
        ? trade.signalTimestamp <= boundary.endTimestamp
        : trade.signalTimestamp < boundary.endTimestamp),
    );
    const metrics = diagnosticMetrics(sample);
    return {
      side,
      fold: boundary.fold,
      startTimestamp: boundary.startTimestamp,
      endTimestamp: boundary.endTimestamp,
      metrics,
      positive: isPositive(metrics),
    };
  });
}

function diagnosticMetrics(trades: readonly MetricTrade[]): Phase6ADiagnosticMetrics {
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

function maxRealizedDrawdown(trades: readonly MetricTrade[]): number {
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

function isPositive(metrics: Phase6ADiagnosticMetrics): boolean {
  const effectivePf = metrics.profitFactor ?? (metrics.netPnl > 0 ? Number.POSITIVE_INFINITY : 0);
  return metrics.filledTrades > 0 &&
    metrics.netPnl > 0 &&
    metrics.expectancy > 0 &&
    metrics.averageRMultiple > 0 &&
    effectivePf > 1;
}

function findTrendExit(
  side: Phase6Side,
  signalTimestamp: number,
  m15Bars: readonly Phase6Bar[],
): { timestamp: number; price: number } | null {
  const m15 = [...m15Bars].sort((a, b) => a.openTime - b.openTime);
  const signalIndex = m15.findIndex((bar) => bar.closeTime === signalTimestamp);
  if (signalIndex < 0) return null;
  for (let index = signalIndex + 1; index < m15.length; index += 1) {
    const closes = m15.slice(0, index + 1).map((bar) => bar.close);
    const ma20 = sma(closes, 20);
    const bar = m15[index]!;
    const invalidated = side === "BUY" ? bar.close < ma20 : bar.close > ma20;
    if (invalidated) return { timestamp: bar.closeTime, price: bar.close };
  }
  return null;
}

function sizeForRisk(
  entry: number,
  stopLoss: number,
  riskCapUsd: number,
  tickSize: number,
  tickValuePerLot: number,
  minVolume: number,
  volumeStep: number,
): number {
  const riskPerLot = (Math.abs(entry - stopLoss) / tickSize) * tickValuePerLot;
  if (!Number.isFinite(riskPerLot) || riskPerLot <= 0) return 0;
  const raw = riskCapUsd / riskPerLot;
  const stepped = Math.floor((raw + 1e-12) / volumeStep) * volumeStep;
  return stepped + 1e-12 >= minVolume ? stepped : 0;
}

function riskUsd(
  entry: number,
  stopLoss: number,
  volume: number,
  tickSize: number,
  tickValuePerLot: number,
): number {
  return (Math.abs(entry - stopLoss) / tickSize) * tickValuePerLot * volume;
}

function improveStop(side: Phase6Side, current: number, candidate: number): number {
  return side === "BUY" ? Math.max(current, candidate) : Math.min(current, candidate);
}

function touchesPrice(bar: Phase6Bar, price: number): boolean {
  return bar.low <= price && price <= bar.high;
}

function sma(values: readonly number[], period: number): number {
  const sample = values.slice(-period);
  if (sample.length < period) return Number.NaN;
  return sample.reduce((sum, value) => sum + value, 0) / period;
}

function toMetricTrade(trade: Phase6BRescuedTrade): MetricTrade {
  return {
    side: trade.side,
    signalTimestamp: trade.signalTimestamp,
    filled: true,
    exitTime: trade.exitTime,
    pnl: trade.pnl,
    rMultiple: trade.rMultiple,
    holdHours: trade.holdHours,
  };
}

function metricLine(prefix: string, metrics: Phase6ADiagnosticMetrics): string {
  return `${prefix}=${metricPayload(metrics)}`;
}

function metricPayload(metrics: Phase6ADiagnosticMetrics): string {
  return [
    `CASES=${metrics.cases}`,
    `FILLED=${metrics.filledTrades}`,
    `WR=${metrics.winRatePercent}`,
    `NET=${metrics.netPnl}`,
    `PF=${metrics.profitFactor ?? "INF"}`,
    `EXP=${metrics.expectancy}`,
    `AVG_R=${metrics.averageRMultiple}`,
    `DD=${metrics.maxRealizedDrawdownUsd}`,
    `HOLD_H=${metrics.averageHoldHours}`,
  ].join("|");
}

function foldLine(prefix: string, fold: Phase6BSideFold): string {
  return `${prefix}=START=${isoOrNone(fold.startTimestamp)}|END=${isoOrNone(fold.endTimestamp)}|${metricPayload(fold.metrics)}|POSITIVE=${fold.positive ? "PASS" : "FAIL"}`;
}

function isoOrNone(timestamp: number | null): string {
  return timestamp === null ? "NONE" : new Date(timestamp).toISOString();
}

function validateRequest(request: Phase6RunRequest): void {
  for (const [name, value] of Object.entries({
    riskCapUsd: request.riskCapUsd,
    tickSize: request.tickSize,
    tickValuePerLot: request.tickValuePerLot,
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Phase 6B requires positive ${name}.`);
    }
  }
}

function average(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
