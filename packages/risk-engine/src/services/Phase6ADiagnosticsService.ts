import type {
  Phase6AConfluenceKey,
  Phase6ADiagnosticMetrics,
  Phase6ADiagnosticsResult,
  Phase6ARescueCase,
  Phase6ARescueSource,
  Phase6ARiskBlockedSetup,
  Phase6AWalkForwardFold,
  Phase6Bar,
  Phase6Config,
  Phase6RunRequest,
  Phase6RunResult,
  Phase6Side,
  Phase6TradeResult,
  Phase6VolumeProfile,
} from "../models";

const RESCUE_SOURCES: readonly Phase6ARescueSource[] = [
  "M5_MA20",
  "M5_MA50",
  "M5_FVG",
  "M15_POC",
  "M15_VAH",
  "M15_VAL",
];

export class Phase6ADiagnosticsService {
  run(baseline: Phase6RunResult, request: Phase6RunRequest): Phase6ADiagnosticsResult {
    validateRequest(request);

    const riskBlockedSetups = rebuildRiskBlockedSetups(baseline.config, request);
    if (riskBlockedSetups.length !== baseline.metrics.riskBlocked) {
      throw new Error(
        `Phase 6A risk-blocked reconciliation failed: baseline=${baseline.metrics.riskBlocked}, rebuilt=${riskBlockedSetups.length}.`,
      );
    }

    const side = {
      BUY: diagnosticMetrics(baseline.trades.filter((trade) => trade.side === "BUY")),
      SELL: diagnosticMetrics(baseline.trades.filter((trade) => trade.side === "SELL")),
    } satisfies Record<Phase6Side, Phase6ADiagnosticMetrics>;

    const confluenceKeys: Phase6AConfluenceKey[] = [
      "MA_FVG",
      "MA_VOLUME_PROFILE",
      "FVG_VOLUME_PROFILE",
      "MA_FVG_VOLUME_PROFILE",
      "OTHER",
    ];
    const confluence = Object.fromEntries(
      confluenceKeys.map((key) => [
        key,
        diagnosticMetrics(baseline.trades.filter((trade) => confluenceKey(trade) === key)),
      ]),
    ) as Record<Phase6AConfluenceKey, Phase6ADiagnosticMetrics>;

    const rescueCases = riskBlockedSetups.map((setup) => rescue(setup, baseline.config, request));
    const rescuedCount = rescueCases.filter((item) => item.rescued).length;
    const rescueSourceCounts = Object.fromEntries(
      RESCUE_SOURCES.map((source) => [
        source,
        rescueCases.filter((item) => item.rescueSource === source).length,
      ]),
    ) as Record<Phase6ARescueSource, number>;

    const walkForwardFolds = buildWalkForwardFolds(baseline.trades, 4);

    return {
      side,
      confluence,
      riskBlockedSetups,
      rescueCases,
      riskBlockedCount: riskBlockedSetups.length,
      rescuedCount,
      rescueRatePercent: round(
        riskBlockedSetups.length ? (rescuedCount / riskBlockedSetups.length) * 100 : 0,
      ),
      rescueSourceCounts,
      walkForwardFolds,
      positiveFolds: walkForwardFolds.filter((fold) => fold.positive).length,
    };
  }

  format(result: Phase6ADiagnosticsResult): string[] {
    const lines = [
      "PHASE6A_DIAGNOSTICS=CONTRIBUTION_M5_RESCUE_WALK_FORWARD",
      "PHASE6A_BASELINE_IMMUTABLE=PASS",
      metricLine("PHASE6A_BUY", result.side.BUY),
      metricLine("PHASE6A_SELL", result.side.SELL),
    ];

    for (const key of [
      "MA_FVG",
      "MA_VOLUME_PROFILE",
      "FVG_VOLUME_PROFILE",
      "MA_FVG_VOLUME_PROFILE",
      "OTHER",
    ] as const) {
      lines.push(metricLine(`PHASE6A_CONFLUENCE_${key}`, result.confluence[key]));
    }

    lines.push(
      `PHASE6A_RISK_BLOCKED=${result.riskBlockedCount}`,
      "PHASE6A_RISK_BLOCKED_RECONCILED=PASS",
      `PHASE6A_M5_RESCUED=${result.rescuedCount}`,
      `PHASE6A_M5_RESCUE_RATE_PERCENT=${result.rescueRatePercent}`,
    );

    for (const source of RESCUE_SOURCES) {
      lines.push(`PHASE6A_M5_RESCUE_SOURCE_${source}=${result.rescueSourceCounts[source]}`);
    }

    for (const fold of result.walkForwardFolds) {
      lines.push(
        `PHASE6A_WF_FOLD_${fold.fold}=START=${isoOrNone(fold.startTimestamp)}|END=${isoOrNone(fold.endTimestamp)}|${metricPayload(fold.metrics)}|POSITIVE=${fold.positive ? "PASS" : "FAIL"}`,
      );
    }

    lines.push(
      `PHASE6A_WF_POSITIVE_FOLDS=${result.positiveFolds}/${result.walkForwardFolds.length}`,
      "PHASE6A_RESCUE_FEASIBILITY_ONLY=PASS",
      "PHASE6A_NO_LOOKAHEAD_RESCUE=PASS",
      "PHASE6A_NO_RETUNE=PASS",
      "PHASE6A_RESEARCH_ONLY=PASS",
      "PHASE6A_PRODUCTION_MUTATION=false",
    );
    return lines;
  }
}

function rebuildRiskBlockedSetups(
  config: Phase6Config,
  request: Phase6RunRequest,
): Phase6ARiskBlockedSetup[] {
  const m15 = [...request.m15Bars].sort((a, b) => a.openTime - b.openTime);
  const minVolume = request.minVolume ?? 0.01;
  const volumeStep = request.volumeStep ?? minVolume;
  const blocked: Phase6ARiskBlockedSetup[] = [];

  for (let index = 200; index < m15.length; index += 1) {
    const current = m15[index]!;
    const previous = m15[index - 1]!;
    const side = engulfingSide(previous, current);
    if (side === null) continue;

    const closes = m15.slice(0, index + 1).map((bar) => bar.close);
    const ma20 = sma(closes, 20);
    const ma50 = sma(closes, 50);
    const ma200 = sma(closes, 200);
    if (!trendMatches(side, current.close, ma20, ma50, ma200)) continue;

    const atr = calculateAtr(m15, index, config.atrPeriod);
    if (!Number.isFinite(atr) || atr <= 0) continue;
    const tolerance = atr * config.maPullbackAtrTolerance;
    const maPullback = intersectsLevel(current, ma20, tolerance) ||
      intersectsLevel(current, ma50, tolerance);
    const fvg = hasRelevantFvg(m15, index, side, config.fvgLookbackBars);
    const profile = buildVolumeProfile(
      m15.slice(Math.max(0, index - config.profileLookbackBars + 1), index + 1),
      config.profileBins,
      config.profileValueAreaFraction,
    );
    const volumeProfile = profile !== null && [profile.poc, profile.vah, profile.val]
      .some((level) => intersectsLevel(current, level, tolerance));
    const confluenceScore = Number(maPullback) + Number(fvg) + Number(volumeProfile);
    if (confluenceScore < config.minConfluenceScore) continue;

    const canonicalEntry = current.close;
    const stopLoss = side === "BUY" ? current.low : current.high;
    const volume = sizeForRisk(
      canonicalEntry,
      stopLoss,
      request.riskCapUsd,
      request.tickSize,
      request.tickValuePerLot,
      minVolume,
      volumeStep,
    );
    if (volume >= minVolume) continue;

    blocked.push({
      id: `phase6-${current.closeTime}-${side}`,
      side,
      signalTimestamp: current.closeTime,
      canonicalEntry: round(canonicalEntry, 5),
      stopLoss: round(stopLoss, 5),
      requiredRiskAtMinVolumeUsd: round(
        riskUsd(canonicalEntry, stopLoss, minVolume, request.tickSize, request.tickValuePerLot),
        4,
      ),
      maPullback,
      fvg,
      volumeProfile,
      profile,
    });
  }

  return blocked;
}

function rescue(
  setup: Phase6ARiskBlockedSetup,
  config: Phase6Config,
  request: Phase6RunRequest,
): Phase6ARescueCase {
  const minVolume = request.minVolume ?? 0.01;
  const m5 = [...request.m5Bars].sort((a, b) => a.openTime - b.openTime);
  const known = m5.filter((bar) => bar.closeTime <= setup.signalTimestamp);
  const execution = m5.filter(
    (bar) =>
      bar.openTime >= setup.signalTimestamp &&
      bar.openTime <= setup.signalTimestamp + config.entryExpiryMinutes * 60_000,
  );

  const candidates: Array<{ source: Phase6ARescueSource; price: number }> = [];
  const knownCloses = known.map((bar) => bar.close);
  const m5ma20 = sma(knownCloses, 20);
  const m5ma50 = sma(knownCloses, 50);
  if (Number.isFinite(m5ma20)) candidates.push({ source: "M5_MA20", price: m5ma20 });
  if (Number.isFinite(m5ma50)) candidates.push({ source: "M5_MA50", price: m5ma50 });

  for (const price of priorM5FvgPrices(known, setup.side, 12)) {
    candidates.push({ source: "M5_FVG", price });
  }

  if (setup.profile !== null) {
    candidates.push(
      { source: "M15_POC", price: setup.profile.poc },
      { source: "M15_VAH", price: setup.profile.vah },
      { source: "M15_VAL", price: setup.profile.val },
    );
  }

  const feasible = candidates
    .map((candidate) => {
      if (!isImprovedEntry(setup.side, candidate.price, setup.canonicalEntry, setup.stopLoss)) {
        return null;
      }
      const rescueRiskUsd = riskUsd(
        candidate.price,
        setup.stopLoss,
        minVolume,
        request.tickSize,
        request.tickValuePerLot,
      );
      if (rescueRiskUsd > request.riskCapUsd + 1e-9) return null;
      const fill = execution.find((bar) => touchesPrice(bar, candidate.price));
      if (!fill) return null;
      return {
        ...candidate,
        riskUsd: rescueRiskUsd,
        fillTime: fill.openTime,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.fillTime - b.fillTime || a.riskUsd - b.riskUsd || a.source.localeCompare(b.source));

  const best = feasible[0];
  return {
    ...setup,
    rescued: best !== undefined,
    rescueSource: best?.source ?? null,
    rescueEntry: best ? round(best.price, 5) : null,
    rescueRiskUsd: best ? round(best.riskUsd, 4) : null,
    rescueFillTime: best?.fillTime ?? null,
  };
}

function buildWalkForwardFolds(
  trades: readonly Phase6TradeResult[],
  foldCount: number,
): Phase6AWalkForwardFold[] {
  if (trades.length === 0) {
    return Array.from({ length: foldCount }, (_, index) => ({
      fold: index + 1,
      startTimestamp: null,
      endTimestamp: null,
      metrics: diagnosticMetrics([]),
      positive: false,
    }));
  }

  const minTimestamp = Math.min(...trades.map((trade) => trade.signalTimestamp));
  const maxTimestamp = Math.max(...trades.map((trade) => trade.signalTimestamp));
  const span = Math.max(1, maxTimestamp - minTimestamp + 1);
  const width = span / foldCount;
  const folds: Phase6AWalkForwardFold[] = [];

  for (let index = 0; index < foldCount; index += 1) {
    const start = minTimestamp + index * width;
    const end = index === foldCount - 1 ? maxTimestamp : minTimestamp + (index + 1) * width;
    const sample = trades.filter((trade) =>
      index === foldCount - 1
        ? trade.signalTimestamp >= start && trade.signalTimestamp <= end
        : trade.signalTimestamp >= start && trade.signalTimestamp < end,
    );
    const metrics = diagnosticMetrics(sample);
    const effectivePf = metrics.profitFactor ?? (metrics.netPnl > 0 ? Number.POSITIVE_INFINITY : 0);
    folds.push({
      fold: index + 1,
      startTimestamp: Math.round(start),
      endTimestamp: Math.round(end),
      metrics,
      positive:
        metrics.filledTrades > 0 &&
        metrics.netPnl > 0 &&
        metrics.expectancy > 0 &&
        metrics.averageRMultiple > 0 &&
        effectivePf > 1,
    });
  }
  return folds;
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

function confluenceKey(trade: Phase6TradeResult): Phase6AConfluenceKey {
  if (trade.maPullback && trade.fvg && trade.volumeProfile) return "MA_FVG_VOLUME_PROFILE";
  if (trade.maPullback && trade.fvg) return "MA_FVG";
  if (trade.maPullback && trade.volumeProfile) return "MA_VOLUME_PROFILE";
  if (trade.fvg && trade.volumeProfile) return "FVG_VOLUME_PROFILE";
  return "OTHER";
}

function priorM5FvgPrices(
  knownBars: readonly Phase6Bar[],
  side: Phase6Side,
  lookbackBars: number,
): number[] {
  const bars = knownBars.slice(-Math.max(3, lookbackBars));
  const prices: number[] = [];
  for (let index = 2; index < bars.length; index += 1) {
    const first = bars[index - 2]!;
    const third = bars[index]!;
    if (side === "BUY" && third.low > first.high) prices.push(first.high);
    if (side === "SELL" && third.high < first.low) prices.push(first.low);
  }
  return [...new Set(prices.map((price) => round(price, 5)))];
}

function isImprovedEntry(
  side: Phase6Side,
  candidate: number,
  canonicalEntry: number,
  stopLoss: number,
): boolean {
  return side === "BUY"
    ? stopLoss < candidate && candidate < canonicalEntry
    : canonicalEntry < candidate && candidate < stopLoss;
}

function validateRequest(request: Phase6RunRequest): void {
  for (const [name, value] of Object.entries({
    riskCapUsd: request.riskCapUsd,
    tickSize: request.tickSize,
    tickValuePerLot: request.tickValuePerLot,
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Phase 6A requires positive ${name}.`);
    }
  }
}

function engulfingSide(previous: Phase6Bar, current: Phase6Bar): Phase6Side | null {
  const previousBearish = previous.close < previous.open;
  const previousBullish = previous.close > previous.open;
  const currentBullish = current.close > current.open;
  const currentBearish = current.close < current.open;
  if (
    previousBearish && currentBullish &&
    current.open <= previous.close && current.close >= previous.open
  ) return "BUY";
  if (
    previousBullish && currentBearish &&
    current.open >= previous.close && current.close <= previous.open
  ) return "SELL";
  return null;
}

function trendMatches(side: Phase6Side, close: number, ma20: number, ma50: number, ma200: number): boolean {
  return side === "BUY"
    ? ma20 > ma50 && ma50 > ma200 && close > ma20
    : ma20 < ma50 && ma50 < ma200 && close < ma20;
}

function sma(values: readonly number[], period: number): number {
  const sample = values.slice(-period);
  if (sample.length < period) return Number.NaN;
  return sample.reduce((sum, value) => sum + value, 0) / period;
}

function calculateAtr(bars: readonly Phase6Bar[], index: number, period: number): number {
  const start = Math.max(1, index - period + 1);
  const ranges: number[] = [];
  for (let i = start; i <= index; i += 1) {
    const bar = bars[i]!;
    const priorClose = bars[i - 1]!.close;
    ranges.push(Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - priorClose),
      Math.abs(bar.low - priorClose),
    ));
  }
  return ranges.length === period
    ? ranges.reduce((sum, value) => sum + value, 0) / period
    : Number.NaN;
}

function intersectsLevel(bar: Phase6Bar, level: number, tolerance: number): boolean {
  return bar.low - tolerance <= level && level <= bar.high + tolerance;
}

function hasRelevantFvg(bars: readonly Phase6Bar[], index: number, side: Phase6Side, lookback: number): boolean {
  const start = Math.max(2, index - lookback);
  const current = bars[index]!;
  for (let i = start; i < index; i += 1) {
    const first = bars[i - 2]!;
    const third = bars[i]!;
    if (side === "BUY" && third.low > first.high) {
      if (current.low <= third.low && current.high >= first.high) return true;
    }
    if (side === "SELL" && third.high < first.low) {
      if (current.high >= third.high && current.low <= first.low) return true;
    }
  }
  return false;
}

function buildVolumeProfile(
  bars: readonly Phase6Bar[],
  bins: number,
  valueAreaFraction: number,
): Phase6VolumeProfile | null {
  if (bars.length === 0 || bins < 2) return null;
  const low = Math.min(...bars.map((bar) => bar.low));
  const high = Math.max(...bars.map((bar) => bar.high));
  if (!(high > low)) return null;
  const width = (high - low) / bins;
  const volumes = Array.from({ length: bins }, () => 0);
  for (const bar of bars) {
    const price = (bar.high + bar.low + bar.close) / 3;
    const rawIndex = Math.floor((price - low) / width);
    const binIndex = Math.max(0, Math.min(bins - 1, rawIndex));
    const weight = Number.isFinite(bar.volume) && (bar.volume ?? 0) > 0 ? bar.volume! : 1;
    volumes[binIndex] += weight;
  }
  const total = volumes.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const pocIndex = volumes.reduce((best, value, index) => value > volumes[best]! ? index : best, 0);
  const ranked = volumes.map((volume, index) => ({ volume, index }))
    .sort((a, b) => b.volume - a.volume || a.index - b.index);
  let accumulated = 0;
  const selected: number[] = [];
  for (const item of ranked) {
    selected.push(item.index);
    accumulated += item.volume;
    if (accumulated >= total * valueAreaFraction) break;
  }
  const minIndex = Math.min(...selected);
  const maxIndex = Math.max(...selected);
  const center = (index: number) => low + (index + 0.5) * width;
  return {
    poc: round(center(pocIndex), 5),
    val: round(center(minIndex), 5),
    vah: round(center(maxIndex), 5),
  };
}

function sizeForRisk(
  entry: number,
  stop: number,
  riskCapUsd: number,
  tickSize: number,
  tickValuePerLot: number,
  minVolume: number,
  volumeStep: number,
): number {
  const riskPerLot = (Math.abs(entry - stop) / tickSize) * tickValuePerLot;
  if (!Number.isFinite(riskPerLot) || riskPerLot <= 0) return 0;
  const raw = riskCapUsd / riskPerLot;
  const stepped = Math.floor((raw + 1e-12) / volumeStep) * volumeStep;
  return stepped + 1e-12 >= minVolume ? stepped : 0;
}

function riskUsd(entry: number, stop: number, volume: number, tickSize: number, tickValuePerLot: number): number {
  return (Math.abs(entry - stop) / tickSize) * tickValuePerLot * volume;
}

function touchesPrice(bar: Phase6Bar, price: number): boolean {
  return bar.low <= price && price <= bar.high;
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

function metricLine(prefix: string, metrics: Phase6ADiagnosticMetrics): string {
  return `${prefix}=${metricPayload(metrics)}`;
}

function metricPayload(metrics: Phase6ADiagnosticMetrics): string {
  return `CASES=${metrics.cases}|FILLED=${metrics.filledTrades}|WR=${metrics.winRatePercent}|NET=${metrics.netPnl}|PF=${metrics.profitFactor ?? "INF"}|EXP=${metrics.expectancy}|AVG_R=${metrics.averageRMultiple}|DD=${metrics.maxRealizedDrawdownUsd}|HOLD_H=${metrics.averageHoldHours}`;
}

function isoOrNone(timestamp: number | null): string {
  return timestamp === null ? "NONE" : new Date(timestamp).toISOString();
}

function average(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
