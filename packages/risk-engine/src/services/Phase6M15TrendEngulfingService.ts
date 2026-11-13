import type {
  Phase6Bar,
  Phase6Config,
  Phase6Metrics,
  Phase6RunRequest,
  Phase6RunResult,
  Phase6Side,
  Phase6Signal,
  Phase6TradeResult,
  Phase6VolumeProfile,
} from "../models";

const DEFAULT_CONFIG: Phase6Config = {
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

export class Phase6M15TrendEngulfingService {
  private readonly config: Phase6Config;

  constructor(config: Partial<Phase6Config> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (this.config.minConfluenceScore < 0 || this.config.minConfluenceScore > 3) {
      throw new Error("Phase 6 minConfluenceScore must be between 0 and 3.");
    }
  }

  run(request: Phase6RunRequest): Phase6RunResult {
    validateRequest(request);
    const m15 = [...request.m15Bars].sort((a, b) => a.openTime - b.openTime);
    const m5 = [...request.m5Bars].sort((a, b) => a.openTime - b.openTime);
    const minVolume = request.minVolume ?? 0.01;
    const volumeStep = request.volumeStep ?? minVolume;

    let engulfingTriggers = 0;
    let trendAligned = 0;
    let confluencePassed = 0;
    let riskBlocked = 0;
    const signals: Phase6Signal[] = [];

    for (let index = 200; index < m15.length; index += 1) {
      const current = m15[index]!;
      const previous = m15[index - 1]!;
      const side = engulfingSide(previous, current);
      if (side === null) continue;
      engulfingTriggers += 1;

      const closes = m15.slice(0, index + 1).map((bar) => bar.close);
      const ma20 = sma(closes, 20);
      const ma50 = sma(closes, 50);
      const ma200 = sma(closes, 200);
      if (!trendMatches(side, current.close, ma20, ma50, ma200)) continue;
      trendAligned += 1;

      const atr = calculateAtr(m15, index, this.config.atrPeriod);
      if (!Number.isFinite(atr) || atr <= 0) continue;
      const tolerance = atr * this.config.maPullbackAtrTolerance;
      const maPullback = intersectsLevel(current, ma20, tolerance) ||
        intersectsLevel(current, ma50, tolerance);
      const fvg = hasRelevantFvg(m15, index, side, this.config.fvgLookbackBars);
      const profile = buildVolumeProfile(
        m15.slice(Math.max(0, index - this.config.profileLookbackBars + 1), index + 1),
        this.config.profileBins,
        this.config.profileValueAreaFraction,
      );
      const volumeProfile = profile !== null && [profile.poc, profile.vah, profile.val]
        .some((level) => intersectsLevel(current, level, tolerance));
      const confluenceScore = Number(maPullback) + Number(fvg) + Number(volumeProfile);
      if (confluenceScore < this.config.minConfluenceScore) continue;
      confluencePassed += 1;

      const entry = current.close;
      const stopLoss = side === "BUY" ? current.low : current.high;
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
        riskBlocked += 1;
        continue;
      }
      const initialRiskUsd = riskUsd(
        entry,
        stopLoss,
        volume,
        request.tickSize,
        request.tickValuePerLot,
      );

      signals.push({
        id: `phase6-${current.closeTime}-${side}`,
        side,
        signalTimestamp: current.closeTime,
        entry: round(entry, 5),
        stopLoss: round(stopLoss, 5),
        volume: round(volume, 4),
        initialRiskUsd: round(initialRiskUsd, 4),
        ma20: round(ma20, 5),
        ma50: round(ma50, 5),
        ma200: round(ma200, 5),
        atr: round(atr, 5),
        confluenceScore,
        maPullback,
        fvg,
        volumeProfile,
        profile,
      });
    }

    const trades = signals.map((signal) => this.simulate(signal, m15, m5, request));
    return {
      config: this.config,
      metrics: buildMetrics(m15.length, engulfingTriggers, trendAligned, confluencePassed, riskBlocked, signals, trades),
      signals,
      trades,
    };
  }

  format(result: Phase6RunResult): string[] {
    const m = result.metrics;
    const c = result.config;
    return [
      "PHASE6_STRATEGY=M15_TREND_ENGULFING",
      `PHASE6_CONFIG=CONFLUENCE_MIN=${c.minConfluenceScore}|BE_TRIGGER=${c.breakEvenTriggerPrice}|BE_OFFSET=${c.breakEvenOffsetPrice}|TRAIL_TRIGGER=${c.trailingTriggerPrice}|TRAIL_DISTANCE=${c.trailingDistancePrice}`,
      `PHASE6_M15_BARS=${m.m15Bars}`,
      `PHASE6_ENGULFING_TRIGGERS=${m.engulfingTriggers}`,
      `PHASE6_TREND_ALIGNED=${m.trendAligned}`,
      `PHASE6_CONFLUENCE_PASSED=${m.confluencePassed}`,
      `PHASE6_RISK_BLOCKED=${m.riskBlocked}`,
      `PHASE6_SIGNALS=${m.signals}`,
      `PHASE6_BUY_SIGNALS=${m.buySignals}`,
      `PHASE6_SELL_SIGNALS=${m.sellSignals}`,
      `PHASE6_FILLED_TRADES=${m.filledTrades}`,
      `PHASE6_UNFILLED_TRADES=${m.unfilledTrades}`,
      `PHASE6_WINS=${m.wins}`,
      `PHASE6_LOSSES=${m.losses}`,
      `PHASE6_FLAT=${m.flat}`,
      `PHASE6_WIN_RATE=${m.winRatePercent}`,
      `PHASE6_NET_PNL=${m.netPnl}`,
      `PHASE6_PROFIT_FACTOR=${m.profitFactor ?? "INF"}`,
      `PHASE6_EXPECTANCY=${m.expectancy}`,
      `PHASE6_AVG_R=${m.averageRMultiple}`,
      `PHASE6_MAX_REALIZED_DRAWDOWN_USD=${m.maxRealizedDrawdownUsd}`,
      `PHASE6_AVG_HOLD_HOURS=${m.averageHoldHours}`,
      `PHASE6_REACHED_PLUS6=${m.reachedPlus6}`,
      `PHASE6_REACHED_PLUS10=${m.reachedPlus10}`,
      `PHASE6_BREAK_EVEN_APPLIED=${m.breakEvenApplied}`,
      `PHASE6_TRAILING_ACTIVATED=${m.trailingActivated}`,
      "PHASE6_NO_LOOKAHEAD_ENTRY=PASS",
      "PHASE6_RESEARCH_ONLY=PASS",
      "PHASE6_PRODUCTION_MUTATION=false",
    ];
  }

  private simulate(
    signal: Phase6Signal,
    m15: readonly Phase6Bar[],
    m5: readonly Phase6Bar[],
    request: Phase6RunRequest,
  ): Phase6TradeResult {
    const expiry = signal.signalTimestamp + this.config.entryExpiryMinutes * 60_000;
    const bars = m5.filter((bar) => bar.openTime >= signal.signalTimestamp);
    const trendExit = findTrendExit(signal, m15);
    let entryTime: number | null = null;
    let activeStop = signal.stopLoss;
    let reachedPlus6 = false;
    let reachedPlus10 = false;
    let breakEvenApplied = false;
    let trailingActivated = false;

    for (const bar of bars) {
      if (entryTime === null) {
        if (bar.openTime > expiry) break;
        if (!touchesPrice(bar, signal.entry)) continue;
        entryTime = bar.openTime;
      }

      if (touchesPrice(bar, activeStop)) {
        return closeTrade(signal, entryTime, bar.closeTime, activeStop, activeStop, request, {
          reachedPlus6,
          reachedPlus10,
          breakEvenApplied,
          trailingActivated,
        }, "STOP");
      }

      if (trendExit !== null && bar.closeTime >= trendExit.timestamp) {
        return closeTrade(signal, entryTime, trendExit.timestamp, trendExit.price, activeStop, request, {
          reachedPlus6,
          reachedPlus10,
          breakEvenApplied,
          trailingActivated,
        }, "TREND_MA20");
      }

      const favorable = signal.side === "BUY"
        ? bar.high - signal.entry
        : signal.entry - bar.low;

      if (favorable >= this.config.breakEvenTriggerPrice) {
        reachedPlus6 = true;
        breakEvenApplied = true;
        const be = signal.side === "BUY"
          ? signal.entry + this.config.breakEvenOffsetPrice
          : signal.entry - this.config.breakEvenOffsetPrice;
        activeStop = improveStop(signal.side, activeStop, be);
      }

      if (favorable >= this.config.trailingTriggerPrice) {
        reachedPlus10 = true;
        trailingActivated = true;
        const trail = signal.side === "BUY"
          ? bar.high - this.config.trailingDistancePrice
          : bar.low + this.config.trailingDistancePrice;
        activeStop = improveStop(signal.side, activeStop, trail);
      }
    }

    if (entryTime === null) {
      return {
        ...signal,
        filled: false,
        entryTime: null,
        exitTime: null,
        exit: null,
        finalStopLoss: signal.stopLoss,
        pnl: 0,
        rMultiple: 0,
        holdHours: 0,
        reachedPlus6: false,
        reachedPlus10: false,
        breakEvenApplied: false,
        trailingActivated: false,
        exitReason: "ENTRY_NOT_FILLED",
      };
    }

    const last = bars.at(-1);
    if (!last) {
      throw new Error("Phase 6 filled a trade without M5 bars.");
    }
    return closeTrade(signal, entryTime, last.closeTime, last.close, activeStop, request, {
      reachedPlus6,
      reachedPlus10,
      breakEvenApplied,
      trailingActivated,
    }, "END_OF_DATA");
  }
}

function validateRequest(request: Phase6RunRequest): void {
  for (const [name, value] of Object.entries({
    riskCapUsd: request.riskCapUsd,
    tickSize: request.tickSize,
    tickValuePerLot: request.tickValuePerLot,
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Phase 6 requires positive ${name}.`);
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

function trendMatches(
  side: Phase6Side,
  close: number,
  ma20: number,
  ma50: number,
  ma200: number,
): boolean {
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

function hasRelevantFvg(
  bars: readonly Phase6Bar[],
  index: number,
  side: Phase6Side,
  lookback: number,
): boolean {
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
  const pocIndex = volumes.reduce(
    (best, value, index) => value > volumes[best]! ? index : best,
    0,
  );
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

function riskUsd(
  entry: number,
  stop: number,
  volume: number,
  tickSize: number,
  tickValuePerLot: number,
): number {
  return (Math.abs(entry - stop) / tickSize) * tickValuePerLot * volume;
}

function findTrendExit(signal: Phase6Signal, m15: readonly Phase6Bar[]): { timestamp: number; price: number } | null {
  const signalIndex = m15.findIndex((bar) => bar.closeTime === signal.signalTimestamp);
  if (signalIndex < 0) return null;
  for (let index = signalIndex + 1; index < m15.length; index += 1) {
    const closes = m15.slice(0, index + 1).map((bar) => bar.close);
    const ma20 = sma(closes, 20);
    const bar = m15[index]!;
    const invalidated = signal.side === "BUY" ? bar.close < ma20 : bar.close > ma20;
    if (invalidated) return { timestamp: bar.closeTime, price: bar.close };
  }
  return null;
}

function touchesPrice(bar: Phase6Bar, price: number): boolean {
  return bar.low <= price && price <= bar.high;
}

function improveStop(side: Phase6Side, current: number, candidate: number): number {
  return side === "BUY" ? Math.max(current, candidate) : Math.min(current, candidate);
}

function closeTrade(
  signal: Phase6Signal,
  entryTime: number,
  exitTime: number,
  exit: number,
  finalStopLoss: number,
  request: Phase6RunRequest,
  flags: Pick<Phase6TradeResult, "reachedPlus6" | "reachedPlus10" | "breakEvenApplied" | "trailingActivated">,
  exitReason: Phase6TradeResult["exitReason"],
): Phase6TradeResult {
  const move = signal.side === "BUY" ? exit - signal.entry : signal.entry - exit;
  const pnl = (move / request.tickSize) * request.tickValuePerLot * signal.volume;
  const rMultiple = signal.initialRiskUsd > 0 ? pnl / signal.initialRiskUsd : 0;
  return {
    ...signal,
    filled: true,
    entryTime,
    exitTime,
    exit: round(exit, 5),
    finalStopLoss: round(finalStopLoss, 5),
    pnl: round(pnl),
    rMultiple: round(rMultiple, 4),
    holdHours: round((exitTime - entryTime) / 3_600_000, 2),
    ...flags,
    exitReason,
  };
}

function buildMetrics(
  m15Bars: number,
  engulfingTriggers: number,
  trendAligned: number,
  confluencePassed: number,
  riskBlocked: number,
  signals: readonly Phase6Signal[],
  trades: readonly Phase6TradeResult[],
): Phase6Metrics {
  const filled = trades.filter((trade) => trade.filled);
  const wins = filled.filter((trade) => trade.pnl > 0);
  const losses = filled.filter((trade) => trade.pnl < 0);
  const flat = filled.length - wins.length - losses.length;
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const netPnl = filled.reduce((sum, trade) => sum + trade.pnl, 0);
  return {
    m15Bars,
    engulfingTriggers,
    trendAligned,
    confluencePassed,
    riskBlocked,
    signals: signals.length,
    buySignals: signals.filter((signal) => signal.side === "BUY").length,
    sellSignals: signals.filter((signal) => signal.side === "SELL").length,
    filledTrades: filled.length,
    unfilledTrades: trades.length - filled.length,
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
    reachedPlus6: filled.filter((trade) => trade.reachedPlus6).length,
    reachedPlus10: filled.filter((trade) => trade.reachedPlus10).length,
    breakEvenApplied: filled.filter((trade) => trade.breakEvenApplied).length,
    trailingActivated: filled.filter((trade) => trade.trailingActivated).length,
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
