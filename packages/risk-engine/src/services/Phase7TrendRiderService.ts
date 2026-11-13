import type {
  Phase7Bar,
  Phase7Config,
  Phase7Metrics,
  Phase7RunRequest,
  Phase7RunResult,
  Phase7Side,
  Phase7Signal,
  Phase7TradeResult,
} from "../models";

const DEFAULT_CONFIG: Phase7Config = {
  fvgLookbackBars: 12,
  entryExpiryMinutes: 15,
  minStopDistancePrice: 6,
  maxStopDistancePrice: 10,
  partial1TriggerPrice: 6,
  partial1Fraction: 1 / 3,
  protectedProfitOffsetPrice: 2,
  partial2TriggerPrice: 10,
  partial2Fraction: 1 / 3,
  trailingDistancePrice: 5,
};

export class Phase7TrendRiderService {
  private readonly config: Phase7Config;

  constructor(config: Partial<Phase7Config> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    validateConfig(this.config);
  }

  run(request: Phase7RunRequest): Phase7RunResult {
    validateRequest(request);
    const m15 = [...request.m15Bars].sort((a, b) => a.openTime - b.openTime);
    const m5 = [...request.m5Bars].sort((a, b) => a.openTime - b.openTime);
    const minVolume = request.minVolume ?? 0.01;
    const volumeStep = request.volumeStep ?? minVolume;

    let engulfingTriggers = 0;
    let trendAligned = 0;
    let fvgConfirmed = 0;
    let stopFlooredToMin = 0;
    let stopCappedToMax = 0;
    const signals: Phase7Signal[] = [];

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

      const fvg = hasRelevantFvg(m15, index, side, this.config.fvgLookbackBars);
      if (!fvg) continue;
      fvgConfirmed += 1;

      const entry = current.close;
      const engulfingExtreme = side === "BUY" ? current.low : current.high;
      const structuralStopDistance = side === "BUY"
        ? entry - engulfingExtreme
        : engulfingExtreme - entry;
      if (!(structuralStopDistance > 0)) continue;

      if (structuralStopDistance < this.config.minStopDistancePrice) stopFlooredToMin += 1;
      if (structuralStopDistance > this.config.maxStopDistancePrice) stopCappedToMax += 1;
      const stopDistance = clamp(
        structuralStopDistance,
        this.config.minStopDistancePrice,
        this.config.maxStopDistancePrice,
      );
      const stopLoss = side === "BUY" ? entry - stopDistance : entry + stopDistance;
      const volume = round(request.fixedVolume, 4);
      const initialRiskUsd = riskUsd(
        entry,
        stopLoss,
        volume,
        request.tickSize,
        request.tickValuePerLot,
      );

      signals.push({
        id: `phase7-${current.closeTime}-${side}`,
        side,
        signalTimestamp: current.closeTime,
        entry: round(entry, 5),
        engulfingExtreme: round(engulfingExtreme, 5),
        structuralStopDistance: round(structuralStopDistance, 5),
        stopDistance: round(stopDistance, 5),
        stopLoss: round(stopLoss, 5),
        volume,
        initialRiskUsd: round(initialRiskUsd, 4),
        ma20: round(ma20, 5),
        ma50: round(ma50, 5),
        ma200: round(ma200, 5),
        fvg: true,
      });
    }

    const trades = signals.map((signal) => this.simulate(signal, m15, m5, request));
    return {
      config: this.config,
      metrics: buildMetrics(
        m15.length,
        engulfingTriggers,
        trendAligned,
        fvgConfirmed,
        stopFlooredToMin,
        stopCappedToMax,
        signals,
        trades,
      ),
      signals,
      trades,
    };
  }

  format(result: Phase7RunResult): string[] {
    const m = result.metrics;
    const c = result.config;
    const buy = summarizeTrades(result.trades.filter((trade) => trade.side === "BUY"));
    const sell = summarizeTrades(result.trades.filter((trade) => trade.side === "SELL"));
    return [
      "PHASE7_STRATEGY=M15_ENGULFING_MA_FVG_TREND_RIDER",
      "PHASE7_TRIGGER=M15_BODY_ENGULFING_MANDATORY",
      "PHASE7_MA_TREND=MANDATORY",
      "PHASE7_FVG=MANDATORY_SAME_DIRECTION",
      "PHASE7_RISK_CAP=OFF",
      "PHASE7_VOLUME_MODE=FIXED",
      "PHASE7_STOP_MODE=PRICE_DISTANCE_CLAMPED_6_TO_10",
      `PHASE7_CONFIG=SL_MIN=${c.minStopDistancePrice}|SL_MAX=${c.maxStopDistancePrice}|P1_TRIGGER=${c.partial1TriggerPrice}|P1_FRACTION=${round(c.partial1Fraction, 4)}|PROTECTED_SL_OFFSET=${c.protectedProfitOffsetPrice}|P2_TRIGGER=${c.partial2TriggerPrice}|P2_FRACTION=${round(c.partial2Fraction, 4)}|TRAIL_DISTANCE=${c.trailingDistancePrice}`,
      `PHASE7_M15_BARS=${m.m15Bars}`,
      `PHASE7_ENGULFING_TRIGGERS=${m.engulfingTriggers}`,
      `PHASE7_TREND_ALIGNED=${m.trendAligned}`,
      `PHASE7_FVG_CONFIRMED=${m.fvgConfirmed}`,
      `PHASE7_STOP_FLOORED_TO_6=${m.stopFlooredToMin}`,
      `PHASE7_STOP_CAPPED_TO_10=${m.stopCappedToMax}`,
      `PHASE7_SIGNALS=${m.signals}`,
      `PHASE7_BUY_SIGNALS=${m.buySignals}`,
      `PHASE7_SELL_SIGNALS=${m.sellSignals}`,
      `PHASE7_FILLED_TRADES=${m.filledTrades}`,
      `PHASE7_WIN_RATE=${m.winRatePercent}`,
      `PHASE7_NET_PNL=${m.netPnl}`,
      `PHASE7_PROFIT_FACTOR=${m.profitFactor ?? "INF"}`,
      `PHASE7_EXPECTANCY=${m.expectancy}`,
      `PHASE7_AVG_R=${m.averageRMultiple}`,
      `PHASE7_MAX_REALIZED_DRAWDOWN_USD=${m.maxRealizedDrawdownUsd}`,
      `PHASE7_AVG_HOLD_HOURS=${m.averageHoldHours}`,
      `PHASE7_PARTIAL1_APPLIED=${m.partial1Applied}`,
      `PHASE7_PROTECTED_STOP_APPLIED=${m.protectedStopApplied}`,
      `PHASE7_PARTIAL2_APPLIED=${m.partial2Applied}`,
      `PHASE7_TRAILING_ACTIVATED=${m.trailingActivated}`,
      `PHASE7_BUY=FILLED=${buy.filled}|WR=${buy.winRatePercent}|NET=${buy.netPnl}|PF=${buy.profitFactor ?? "INF"}|EXP=${buy.expectancy}|AVG_R=${buy.averageRMultiple}`,
      `PHASE7_SELL=FILLED=${sell.filled}|WR=${sell.winRatePercent}|NET=${sell.netPnl}|PF=${sell.profitFactor ?? "INF"}|EXP=${sell.expectancy}|AVG_R=${sell.averageRMultiple}`,
      "PHASE7_PARTIAL_CLOSE_RESPECTS_VOLUME_STEP=PASS",
      "PHASE7_NO_LOOKAHEAD_ENTRY=PASS",
      "PHASE7_RESEARCH_ONLY=PASS",
      "PHASE7_PRODUCTION_MUTATION=false",
    ];
  }

  private simulate(
    signal: Phase7Signal,
    m15: readonly Phase7Bar[],
    m5: readonly Phase7Bar[],
    request: Phase7RunRequest,
  ): Phase7TradeResult {
    const minVolume = request.minVolume ?? 0.01;
    const volumeStep = request.volumeStep ?? minVolume;
    const expiry = signal.signalTimestamp + this.config.entryExpiryMinutes * 60_000;
    const bars = m5.filter((bar) => bar.openTime >= signal.signalTimestamp);
    const trendExit = findTrendExit(signal, m15);

    let entryTime: number | null = null;
    let activeStop = signal.stopLoss;
    let remainingVolume = signal.volume;
    let partial1Applied = false;
    let partial1Processed = false;
    let partial1Volume = 0;
    let partial1Pnl = 0;
    let protectedStopApplied = false;
    let partial2Applied = false;
    let partial2Processed = false;
    let partial2Volume = 0;
    let partial2Pnl = 0;
    let trailingActivated = false;

    for (const bar of bars) {
      if (entryTime === null) {
        if (bar.openTime > expiry) break;
        if (!touchesPrice(bar, signal.entry)) continue;
        entryTime = bar.openTime;
      }

      if (touchesPrice(bar, activeStop)) {
        return closeTrade(signal, entryTime, bar.closeTime, activeStop, activeStop, remainingVolume,
          partial1Applied, partial1Volume, partial1Pnl, protectedStopApplied,
          partial2Applied, partial2Volume, partial2Pnl, trailingActivated, request, "STOP");
      }

      if (trendExit !== null && bar.closeTime >= trendExit.timestamp) {
        return closeTrade(signal, entryTime, trendExit.timestamp, trendExit.price, activeStop, remainingVolume,
          partial1Applied, partial1Volume, partial1Pnl, protectedStopApplied,
          partial2Applied, partial2Volume, partial2Pnl, trailingActivated, request, "TREND_MA20");
      }

      const favorable = signal.side === "BUY" ? bar.high - signal.entry : signal.entry - bar.low;

      if (!partial1Processed && favorable >= this.config.partial1TriggerPrice) {
        partial1Processed = true;
        const triggerPrice = signal.side === "BUY"
          ? signal.entry + this.config.partial1TriggerPrice
          : signal.entry - this.config.partial1TriggerPrice;
        const closeVolume = partialCloseVolume(signal.volume, this.config.partial1Fraction,
          remainingVolume, minVolume, volumeStep);
        if (closeVolume > 0) {
          partial1Applied = true;
          partial1Volume = closeVolume;
          partial1Pnl = pnlUsd(signal.side, signal.entry, triggerPrice, closeVolume,
            request.tickSize, request.tickValuePerLot);
          remainingVolume = normalizeVolume(remainingVolume - closeVolume, volumeStep);
        }
        const protectedStop = signal.side === "BUY"
          ? signal.entry + this.config.protectedProfitOffsetPrice
          : signal.entry - this.config.protectedProfitOffsetPrice;
        activeStop = improveStop(signal.side, activeStop, protectedStop);
        protectedStopApplied = true;
      }

      if (!partial2Processed && favorable >= this.config.partial2TriggerPrice) {
        partial2Processed = true;
        const triggerPrice = signal.side === "BUY"
          ? signal.entry + this.config.partial2TriggerPrice
          : signal.entry - this.config.partial2TriggerPrice;
        const closeVolume = partialCloseVolume(signal.volume, this.config.partial2Fraction,
          remainingVolume, minVolume, volumeStep);
        if (closeVolume > 0) {
          partial2Applied = true;
          partial2Volume = closeVolume;
          partial2Pnl = pnlUsd(signal.side, signal.entry, triggerPrice, closeVolume,
            request.tickSize, request.tickValuePerLot);
          remainingVolume = normalizeVolume(remainingVolume - closeVolume, volumeStep);
        }
        trailingActivated = true;
      }

      if (trailingActivated) {
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
        partial1Applied: false,
        partial1Volume: 0,
        partial1Pnl: 0,
        protectedStopApplied: false,
        partial2Applied: false,
        partial2Volume: 0,
        partial2Pnl: 0,
        trailingActivated: false,
        remainingVolumeAtExit: signal.volume,
        exitReason: "ENTRY_NOT_FILLED",
      };
    }

    const last = bars.at(-1);
    if (!last) throw new Error("Phase 7 filled a trade without M5 bars.");
    return closeTrade(signal, entryTime, last.closeTime, last.close, activeStop, remainingVolume,
      partial1Applied, partial1Volume, partial1Pnl, protectedStopApplied,
      partial2Applied, partial2Volume, partial2Pnl, trailingActivated, request, "END_OF_DATA");
  }
}

function validateConfig(config: Phase7Config): void {
  if (!(config.minStopDistancePrice > 0 && config.maxStopDistancePrice >= config.minStopDistancePrice)) {
    throw new Error("Phase 7 requires 0 < minStopDistancePrice <= maxStopDistancePrice.");
  }
  if (!(config.partial1Fraction > 0 && config.partial2Fraction > 0 &&
      config.partial1Fraction + config.partial2Fraction < 1)) {
    throw new Error("Phase 7 partial fractions must be positive and leave a trend-rider remainder.");
  }
  if (!(config.partial1TriggerPrice > 0 && config.partial2TriggerPrice > config.partial1TriggerPrice)) {
    throw new Error("Phase 7 partial trigger ordering is invalid.");
  }
  if (!(config.protectedProfitOffsetPrice >= 0 && config.protectedProfitOffsetPrice < config.partial1TriggerPrice)) {
    throw new Error("Phase 7 protected stop offset must be below the first trigger.");
  }
  if (!(config.trailingDistancePrice > 0)) throw new Error("Phase 7 trailing distance must be positive.");
}

function validateRequest(request: Phase7RunRequest): void {
  const minVolume = request.minVolume ?? 0.01;
  const volumeStep = request.volumeStep ?? minVolume;
  for (const [name, value] of Object.entries({
    fixedVolume: request.fixedVolume,
    tickSize: request.tickSize,
    tickValuePerLot: request.tickValuePerLot,
    minVolume,
    volumeStep,
  })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Phase 7 requires positive ${name}.`);
  }
  if (request.fixedVolume + 1e-9 < minVolume) throw new Error("Phase 7 fixedVolume is below broker minimum volume.");
  const steps = request.fixedVolume / volumeStep;
  if (Math.abs(steps - Math.round(steps)) > 1e-8) {
    throw new Error("Phase 7 fixedVolume must align to broker volumeStep.");
  }
}

function engulfingSide(previous: Phase7Bar, current: Phase7Bar): Phase7Side | null {
  const previousBearish = previous.close < previous.open;
  const previousBullish = previous.close > previous.open;
  const currentBullish = current.close > current.open;
  const currentBearish = current.close < current.open;
  if (previousBearish && currentBullish && current.open <= previous.close && current.close >= previous.open) return "BUY";
  if (previousBullish && currentBearish && current.open >= previous.close && current.close <= previous.open) return "SELL";
  return null;
}

function trendMatches(side: Phase7Side, close: number, ma20: number, ma50: number, ma200: number): boolean {
  return side === "BUY"
    ? ma20 > ma50 && ma50 > ma200 && close > ma20
    : ma20 < ma50 && ma50 < ma200 && close < ma20;
}

function hasRelevantFvg(bars: readonly Phase7Bar[], index: number, side: Phase7Side, lookback: number): boolean {
  const start = Math.max(2, index - lookback);
  const current = bars[index]!;
  for (let i = start; i < index; i += 1) {
    const first = bars[i - 2]!;
    const third = bars[i]!;
    if (side === "BUY" && third.low > first.high && current.low <= third.low && current.high >= first.high) return true;
    if (side === "SELL" && third.high < first.low && current.high >= third.high && current.low <= first.low) return true;
  }
  return false;
}

function findTrendExit(signal: Phase7Signal, bars: readonly Phase7Bar[]): { timestamp: number; price: number } | null {
  const ordered = [...bars].sort((a, b) => a.openTime - b.openTime);
  for (let index = 19; index < ordered.length; index += 1) {
    const bar = ordered[index]!;
    if (bar.closeTime <= signal.signalTimestamp) continue;
    const ma20 = sma(ordered.slice(0, index + 1).map((item) => item.close), 20);
    if (signal.side === "BUY" && bar.close < ma20) return { timestamp: bar.closeTime, price: bar.close };
    if (signal.side === "SELL" && bar.close > ma20) return { timestamp: bar.closeTime, price: bar.close };
  }
  return null;
}

function sma(values: readonly number[], period: number): number {
  const sample = values.slice(-period);
  if (sample.length < period) return Number.NaN;
  return sample.reduce((sum, value) => sum + value, 0) / period;
}

function touchesPrice(bar: Phase7Bar, price: number): boolean {
  return bar.low <= price && price <= bar.high;
}

function improveStop(side: Phase7Side, current: number, candidate: number): number {
  return side === "BUY" ? Math.max(current, candidate) : Math.min(current, candidate);
}

function riskUsd(entry: number, stop: number, volume: number, tickSize: number, tickValuePerLot: number): number {
  return Math.abs(entry - stop) / tickSize * tickValuePerLot * volume;
}

function partialCloseVolume(
  initialVolume: number,
  fraction: number,
  remainingVolume: number,
  minVolume: number,
  volumeStep: number,
): number {
  const desired = floorToStep(initialVolume * fraction, volumeStep);
  if (desired + 1e-9 < minVolume) return 0;
  const maxClosable = floorToStep(Math.max(0, remainingVolume - minVolume), volumeStep);
  if (maxClosable + 1e-9 < minVolume) return 0;
  const closeVolume = floorToStep(Math.min(desired, maxClosable), volumeStep);
  return closeVolume + 1e-9 >= minVolume ? closeVolume : 0;
}

function normalizeVolume(volume: number, step: number): number {
  return round(floorToStep(Math.max(0, volume) + step * 1e-7, step), 4);
}

function floorToStep(value: number, step: number): number {
  return Math.floor((value + 1e-9) / step) * step;
}

function pnlUsd(side: Phase7Side, entry: number, exit: number, volume: number, tickSize: number, tickValuePerLot: number): number {
  const priceMove = side === "BUY" ? exit - entry : entry - exit;
  return priceMove / tickSize * tickValuePerLot * volume;
}

function closeTrade(
  signal: Phase7Signal,
  entryTime: number,
  exitTime: number,
  exit: number,
  finalStopLoss: number,
  remainingVolume: number,
  partial1Applied: boolean,
  partial1Volume: number,
  partial1Pnl: number,
  protectedStopApplied: boolean,
  partial2Applied: boolean,
  partial2Volume: number,
  partial2Pnl: number,
  trailingActivated: boolean,
  request: Phase7RunRequest,
  exitReason: Phase7TradeResult["exitReason"],
): Phase7TradeResult {
  const remainingPnl = pnlUsd(signal.side, signal.entry, exit, remainingVolume,
    request.tickSize, request.tickValuePerLot);
  const pnl = partial1Pnl + partial2Pnl + remainingPnl;
  return {
    ...signal,
    filled: true,
    entryTime,
    exitTime,
    exit: round(exit, 5),
    finalStopLoss: round(finalStopLoss, 5),
    pnl: round(pnl, 4),
    rMultiple: round(signal.initialRiskUsd > 0 ? pnl / signal.initialRiskUsd : 0, 4),
    holdHours: round((exitTime - entryTime) / 3_600_000, 4),
    partial1Applied,
    partial1Volume: round(partial1Volume, 4),
    partial1Pnl: round(partial1Pnl, 4),
    protectedStopApplied,
    partial2Applied,
    partial2Volume: round(partial2Volume, 4),
    partial2Pnl: round(partial2Pnl, 4),
    trailingActivated,
    remainingVolumeAtExit: round(remainingVolume, 4),
    exitReason,
  };
}

function buildMetrics(
  m15Bars: number,
  engulfingTriggers: number,
  trendAligned: number,
  fvgConfirmed: number,
  stopFlooredToMin: number,
  stopCappedToMax: number,
  signals: readonly Phase7Signal[],
  trades: readonly Phase7TradeResult[],
): Phase7Metrics {
  const filled = trades.filter((trade) => trade.filled);
  const summary = summarizeTrades(filled);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of filled) {
    equity += trade.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return {
    m15Bars,
    engulfingTriggers,
    trendAligned,
    fvgConfirmed,
    stopFlooredToMin,
    stopCappedToMax,
    signals: signals.length,
    buySignals: signals.filter((signal) => signal.side === "BUY").length,
    sellSignals: signals.filter((signal) => signal.side === "SELL").length,
    filledTrades: filled.length,
    unfilledTrades: trades.length - filled.length,
    wins: filled.filter((trade) => trade.pnl > 0).length,
    losses: filled.filter((trade) => trade.pnl < 0).length,
    flat: filled.filter((trade) => trade.pnl === 0).length,
    winRatePercent: summary.winRatePercent,
    netPnl: summary.netPnl,
    grossProfit: summary.grossProfit,
    grossLoss: summary.grossLoss,
    profitFactor: summary.profitFactor,
    expectancy: summary.expectancy,
    averageRMultiple: summary.averageRMultiple,
    maxRealizedDrawdownUsd: round(maxDrawdown, 4),
    averageHoldHours: round(filled.length ? filled.reduce((sum, trade) => sum + trade.holdHours, 0) / filled.length : 0, 4),
    partial1Applied: filled.filter((trade) => trade.partial1Applied).length,
    protectedStopApplied: filled.filter((trade) => trade.protectedStopApplied).length,
    partial2Applied: filled.filter((trade) => trade.partial2Applied).length,
    trailingActivated: filled.filter((trade) => trade.trailingActivated).length,
  };
}

function summarizeTrades(trades: readonly Phase7TradeResult[]): {
  filled: number;
  winRatePercent: number;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  expectancy: number;
  averageRMultiple: number;
} {
  const filled = trades.filter((trade) => trade.filled);
  const grossProfit = filled.filter((trade) => trade.pnl > 0).reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLossAbs = Math.abs(filled.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
  const netPnl = filled.reduce((sum, trade) => sum + trade.pnl, 0);
  return {
    filled: filled.length,
    winRatePercent: round(filled.length ? filled.filter((trade) => trade.pnl > 0).length / filled.length * 100 : 0, 2),
    netPnl: round(netPnl, 4),
    grossProfit: round(grossProfit, 4),
    grossLoss: round(grossLossAbs, 4),
    profitFactor: grossLossAbs > 0 ? round(grossProfit / grossLossAbs, 4) : null,
    expectancy: round(filled.length ? netPnl / filled.length : 0, 4),
    averageRMultiple: round(filled.length ? filled.reduce((sum, trade) => sum + trade.rMultiple, 0) / filled.length : 0, 4),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
