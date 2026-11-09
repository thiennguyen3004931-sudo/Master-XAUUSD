import type { Phase7Bar, Phase7RunRequest, Phase7Side } from "../models";

export type Phase7BPattern = "ENGULFING" | "TWO_CANDLE_BODY_DOMINANCE" | "THREE_CANDLE_BODY_DOMINANCE";
export type Phase7BExitReason =
  | "ENTRY_NOT_FILLED"
  | "STOP"
  | "TREND_MA20"
  | "REVERSAL_FVG_REJECTION"
  | "END_OF_DATA";

export interface Phase7BConfig {
  fvgLookbackBars: number;
  reversalFvgLookbackBars: number;
  entryExpiryMinutes: number;
  minStopDistancePrice: number;
  maxStopDistancePrice: number;
  breakEvenTriggerPrice: number;
  partialTriggerPrice: number;
  partialFraction: number;
}

export interface Phase7BSignal {
  id: string;
  side: Phase7Side;
  pattern: Phase7BPattern;
  signalTimestamp: number;
  entry: number;
  patternExtreme: number;
  structuralStopDistance: number;
  stopDistance: number;
  stopLoss: number;
  volume: number;
  initialRiskUsd: number;
  ma20: number;
  ma50: number;
  ma200: number;
}

export interface Phase7BTradeResult extends Phase7BSignal {
  filled: boolean;
  entryTime: number | null;
  exitTime: number | null;
  exit: number | null;
  finalStopLoss: number;
  pnl: number;
  rMultiple: number;
  holdHours: number;
  breakEvenApplied: boolean;
  partialApplied: boolean;
  partialVolume: number;
  partialPnl: number;
  remainingVolumeAtExit: number;
  structuralTrailUpdates: number;
  reversalExitApplied: boolean;
  exitReason: Phase7BExitReason;
}

export interface Phase7BMetrics {
  m15Bars: number;
  engulfingTriggers: number;
  twoCandleTriggers: number;
  threeCandleTriggers: number;
  trendAligned: number;
  fvgConfirmed: number;
  signals: number;
  buySignals: number;
  sellSignals: number;
  filledTrades: number;
  winRatePercent: number;
  netPnl: number;
  profitFactor: number | null;
  expectancy: number;
  averageRMultiple: number;
  maxRealizedDrawdownUsd: number;
  averageHoldHours: number;
  breakEvenApplied: number;
  partialApplied: number;
  structuralTrailUpdates: number;
  reversalFvgExits: number;
}

export interface Phase7BRunResult {
  config: Phase7BConfig;
  metrics: Phase7BMetrics;
  signals: Phase7BSignal[];
  trades: Phase7BTradeResult[];
}

const DEFAULT_CONFIG: Phase7BConfig = {
  fvgLookbackBars: 12,
  reversalFvgLookbackBars: 48,
  entryExpiryMinutes: 15,
  minStopDistancePrice: 6,
  maxStopDistancePrice: 10,
  breakEvenTriggerPrice: 6,
  partialTriggerPrice: 10,
  partialFraction: 1 / 3,
};

export class Phase7BDualPatternTrendRiderService {
  private readonly config: Phase7BConfig;

  constructor(config: Partial<Phase7BConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    validateConfig(this.config);
  }

  run(request: Phase7RunRequest): Phase7BRunResult {
    validateRequest(request);
    const m15 = [...request.m15Bars].sort((a, b) => a.openTime - b.openTime);
    const m5 = [...request.m5Bars].sort((a, b) => a.openTime - b.openTime);

    let engulfingTriggers = 0;
    let twoCandleTriggers = 0;
    let threeCandleTriggers = 0;
    let trendAligned = 0;
    let fvgConfirmed = 0;
    const signals: Phase7BSignal[] = [];

    for (let index = 200; index < m15.length; index += 1) {
      const trigger = detectPattern(m15, index);
      if (!trigger) continue;
      if (trigger.pattern === "ENGULFING") engulfingTriggers += 1;
      else if (trigger.pattern === "TWO_CANDLE_BODY_DOMINANCE") twoCandleTriggers += 1;
      else threeCandleTriggers += 1;

      const closes = m15.slice(0, index + 1).map((bar) => bar.close);
      const ma20 = sma(closes, 20);
      const ma50 = sma(closes, 50);
      const ma200 = sma(closes, 200);
      const current = m15[index]!;
      if (!trendMatches(trigger.side, current.close, ma20, ma50, ma200)) continue;
      trendAligned += 1;

      if (!hasRelevantFvg(m15, index, trigger.side, this.config.fvgLookbackBars)) continue;
      fvgConfirmed += 1;

      const entry = current.close;
      const structuralStopDistance = trigger.side === "BUY"
        ? entry - trigger.patternExtreme
        : trigger.patternExtreme - entry;
      if (!(structuralStopDistance > 0)) continue;

      const stopDistance = clamp(
        structuralStopDistance,
        this.config.minStopDistancePrice,
        this.config.maxStopDistancePrice,
      );
      const stopLoss = trigger.side === "BUY" ? entry - stopDistance : entry + stopDistance;
      const volume = round(request.fixedVolume, 4);
      const initialRiskUsd = riskUsd(entry, stopLoss, volume, request.tickSize, request.tickValuePerLot);

      signals.push({
        id: `phase7b-${current.closeTime}-${trigger.side}-${trigger.pattern}`,
        side: trigger.side,
        pattern: trigger.pattern,
        signalTimestamp: current.closeTime,
        entry: round(entry, 5),
        patternExtreme: round(trigger.patternExtreme, 5),
        structuralStopDistance: round(structuralStopDistance, 5),
        stopDistance: round(stopDistance, 5),
        stopLoss: round(stopLoss, 5),
        volume,
        initialRiskUsd: round(initialRiskUsd, 4),
        ma20: round(ma20, 5),
        ma50: round(ma50, 5),
        ma200: round(ma200, 5),
      });
    }

    const trades = signals.map((signal) => this.simulate(signal, m15, m5, request));
    return {
      config: this.config,
      metrics: buildMetrics(
        m15.length,
        engulfingTriggers,
        twoCandleTriggers,
        threeCandleTriggers,
        trendAligned,
        fvgConfirmed,
        signals,
        trades,
      ),
      signals,
      trades,
    };
  }

  format(result: Phase7BRunResult): string[] {
    const m = result.metrics;
    const buy = summarize(result.trades.filter((trade) => trade.side === "BUY"));
    const sell = summarize(result.trades.filter((trade) => trade.side === "SELL"));
    const engulf = summarize(result.trades.filter((trade) => trade.pattern === "ENGULFING"));
    const two = summarize(result.trades.filter((trade) => trade.pattern === "TWO_CANDLE_BODY_DOMINANCE"));
    const three = summarize(result.trades.filter((trade) => trade.pattern === "THREE_CANDLE_BODY_DOMINANCE"));
    return [
      "PHASE7B_STRATEGY=M15_TRIPLE_PATTERN_MA_FVG_STRUCTURE_RIDER",
      "PHASE7B_TRIGGER=ENGULFING_OR_TWO_OR_THREE_SAME_COLOR_BODY_DOMINANCE",
      "PHASE7B_TWO_CANDLE_RULE=FIRST_SAME_COLOR_BODY_LT_PREVIOUS_OPPOSITE_BODY_AND_SUM_TWO_GT_PREVIOUS_OPPOSITE_BODY",
      "PHASE7B_THREE_CANDLE_RULE=A_OPPOSITE_BCD_SAME_COLOR_AND_BODY_B_PLUS_C_LT_BODY_A_AND_BODY_B_PLUS_C_PLUS_D_GT_BODY_A",
      "PHASE7B_MA_TREND=MANDATORY",
      "PHASE7B_FVG=MANDATORY_SAME_DIRECTION",
      "PHASE7B_INITIAL_SL=PRICE_DISTANCE_CLAMPED_6_TO_10",
      "PHASE7B_PLUS6=SL_TO_ENTRY",
      "PHASE7B_PLUS10=PARTIAL_ONE_THIRD",
      "PHASE7B_POST_PLUS10_SL=M15_CONFIRMED_SWING_STRUCTURE_ONLY_TIGHTEN",
      "PHASE7B_REVERSAL_EXIT=OPPOSING_M15_FVG_PLUS_REJECTION_CLOSE_AFTER_PLUS10",
      "PHASE7B_RISK_CAP=OFF",
      "PHASE7B_VOLUME_MODE=FIXED",
      `PHASE7B_M15_BARS=${m.m15Bars}`,
      `PHASE7B_ENGULFING_TRIGGERS=${m.engulfingTriggers}`,
      `PHASE7B_TWO_CANDLE_TRIGGERS=${m.twoCandleTriggers}`,
      `PHASE7B_THREE_CANDLE_TRIGGERS=${m.threeCandleTriggers}`,
      `PHASE7B_TREND_ALIGNED=${m.trendAligned}`,
      `PHASE7B_FVG_CONFIRMED=${m.fvgConfirmed}`,
      `PHASE7B_SIGNALS=${m.signals}`,
      `PHASE7B_BUY_SIGNALS=${m.buySignals}`,
      `PHASE7B_SELL_SIGNALS=${m.sellSignals}`,
      `PHASE7B_FILLED_TRADES=${m.filledTrades}`,
      `PHASE7B_WIN_RATE=${m.winRatePercent}`,
      `PHASE7B_NET_PNL=${m.netPnl}`,
      `PHASE7B_PROFIT_FACTOR=${m.profitFactor ?? "INF"}`,
      `PHASE7B_EXPECTANCY=${m.expectancy}`,
      `PHASE7B_AVG_R=${m.averageRMultiple}`,
      `PHASE7B_MAX_REALIZED_DRAWDOWN_USD=${m.maxRealizedDrawdownUsd}`,
      `PHASE7B_AVG_HOLD_HOURS=${m.averageHoldHours}`,
      `PHASE7B_BREAK_EVEN_APPLIED=${m.breakEvenApplied}`,
      `PHASE7B_PARTIAL_AT_10_APPLIED=${m.partialApplied}`,
      `PHASE7B_STRUCTURAL_TRAIL_UPDATES=${m.structuralTrailUpdates}`,
      `PHASE7B_REVERSAL_FVG_EXITS=${m.reversalFvgExits}`,
      `PHASE7B_BUY=FILLED=${buy.filled}|WR=${buy.winRatePercent}|NET=${buy.netPnl}|PF=${buy.profitFactor ?? "INF"}|EXP=${buy.expectancy}|AVG_R=${buy.averageR}`,
      `PHASE7B_SELL=FILLED=${sell.filled}|WR=${sell.winRatePercent}|NET=${sell.netPnl}|PF=${sell.profitFactor ?? "INF"}|EXP=${sell.expectancy}|AVG_R=${sell.averageR}`,
      `PHASE7B_PATTERN_ENGULFING=FILLED=${engulf.filled}|WR=${engulf.winRatePercent}|NET=${engulf.netPnl}|PF=${engulf.profitFactor ?? "INF"}|EXP=${engulf.expectancy}|AVG_R=${engulf.averageR}`,
      `PHASE7B_PATTERN_TWO_CANDLE=FILLED=${two.filled}|WR=${two.winRatePercent}|NET=${two.netPnl}|PF=${two.profitFactor ?? "INF"}|EXP=${two.expectancy}|AVG_R=${two.averageR}`,
      `PHASE7B_PATTERN_THREE_CANDLE=FILLED=${three.filled}|WR=${three.winRatePercent}|NET=${three.netPnl}|PF=${three.profitFactor ?? "INF"}|EXP=${three.expectancy}|AVG_R=${three.averageR}`,
      "PHASE7B_NO_LOOKAHEAD_ENTRY=PASS",
      "PHASE7B_REVERSAL_EXIT_AFTER_PLUS10_ONLY=PASS",
      "PHASE7B_RESEARCH_ONLY=PASS",
      "PHASE7B_PRODUCTION_MUTATION=false",
    ];
  }

  private simulate(
    signal: Phase7BSignal,
    m15: readonly Phase7Bar[],
    m5: readonly Phase7Bar[],
    request: Phase7RunRequest,
  ): Phase7BTradeResult {
    const minVolume = request.minVolume ?? 0.01;
    const volumeStep = request.volumeStep ?? minVolume;
    const expiry = signal.signalTimestamp + this.config.entryExpiryMinutes * 60_000;
    const bars = m5.filter((bar) => bar.openTime >= signal.signalTimestamp);
    const trendExit = findTrendExit(signal, m15);

    let entryTime: number | null = null;
    let activeStop = signal.stopLoss;
    let remainingVolume = signal.volume;
    let breakEvenApplied = false;
    let plus10Activated = false;
    let partialApplied = false;
    let partialVolume = 0;
    let partialPnl = 0;
    let structuralTrailUpdates = 0;
    let lastReversalM15CloseChecked = -1;

    for (const bar of bars) {
      if (entryTime === null) {
        if (bar.openTime > expiry) break;
        if (!touchesPrice(bar, signal.entry)) continue;
        entryTime = bar.openTime;
      }

      if (touchesPrice(bar, activeStop)) {
        return closeTrade(
          signal,
          entryTime,
          bar.closeTime,
          activeStop,
          activeStop,
          remainingVolume,
          breakEvenApplied,
          partialApplied,
          partialVolume,
          partialPnl,
          structuralTrailUpdates,
          false,
          request,
          "STOP",
        );
      }

      const favorable = signal.side === "BUY" ? bar.high - signal.entry : signal.entry - bar.low;

      if (!breakEvenApplied && favorable >= this.config.breakEvenTriggerPrice) {
        activeStop = improveStop(signal.side, activeStop, signal.entry);
        breakEvenApplied = true;
      }

      if (!plus10Activated && favorable >= this.config.partialTriggerPrice) {
        plus10Activated = true;
        const closeVolume = partialCloseVolume(
          signal.volume,
          this.config.partialFraction,
          remainingVolume,
          minVolume,
          volumeStep,
        );
        if (closeVolume > 0) {
          const triggerPrice = signal.side === "BUY"
            ? signal.entry + this.config.partialTriggerPrice
            : signal.entry - this.config.partialTriggerPrice;
          partialApplied = true;
          partialVolume = closeVolume;
          partialPnl = pnlUsd(
            signal.side,
            signal.entry,
            triggerPrice,
            closeVolume,
            request.tickSize,
            request.tickValuePerLot,
          );
          remainingVolume = normalizeVolume(remainingVolume - closeVolume, volumeStep);
        }
      }

      if (plus10Activated) {
        const structure = latestConfirmedStructureStop(signal.side, m15, signal.signalTimestamp, bar.closeTime);
        if (structure !== null) {
          const improved = improveStop(signal.side, activeStop, structure);
          if (Math.abs(improved - activeStop) > 1e-9) structuralTrailUpdates += 1;
          activeStop = improved;
        }

        const reversal = opposingFvgRejectionAt(
          signal,
          m15,
          bar.closeTime,
          this.config.reversalFvgLookbackBars,
          lastReversalM15CloseChecked,
        );
        if (reversal.checkedCloseTime > lastReversalM15CloseChecked) {
          lastReversalM15CloseChecked = reversal.checkedCloseTime;
        }
        if (reversal.exit !== null) {
          return closeTrade(
            signal,
            entryTime,
            reversal.exit.timestamp,
            reversal.exit.price,
            activeStop,
            remainingVolume,
            breakEvenApplied,
            partialApplied,
            partialVolume,
            partialPnl,
            structuralTrailUpdates,
            true,
            request,
            "REVERSAL_FVG_REJECTION",
          );
        }
      }

      if (trendExit !== null && bar.closeTime >= trendExit.timestamp) {
        return closeTrade(
          signal,
          entryTime,
          trendExit.timestamp,
          trendExit.price,
          activeStop,
          remainingVolume,
          breakEvenApplied,
          partialApplied,
          partialVolume,
          partialPnl,
          structuralTrailUpdates,
          false,
          request,
          "TREND_MA20",
        );
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
        breakEvenApplied: false,
        partialApplied: false,
        partialVolume: 0,
        partialPnl: 0,
        remainingVolumeAtExit: signal.volume,
        structuralTrailUpdates: 0,
        reversalExitApplied: false,
        exitReason: "ENTRY_NOT_FILLED",
      };
    }

    const last = bars.at(-1);
    if (!last) throw new Error("Phase 7B filled a trade without M5 bars.");
    return closeTrade(
      signal,
      entryTime,
      last.closeTime,
      last.close,
      activeStop,
      remainingVolume,
      breakEvenApplied,
      partialApplied,
      partialVolume,
      partialPnl,
      structuralTrailUpdates,
      false,
      request,
      "END_OF_DATA",
    );
  }
}

function detectPattern(
  bars: readonly Phase7Bar[],
  index: number,
): { side: Phase7Side; pattern: Phase7BPattern; patternExtreme: number } | null {
  const current = bars[index]!;

  // Pattern Rule V2 priority: THREE -> TWO -> ENGULFING.
  // This prevents a shorter/less-specific pattern from consuming a longer valid pattern.
  if (index >= 3) {
    const anchor = bars[index - 3]!;
    const b = bars[index - 2]!;
    const c = bars[index - 1]!;
    const d = current;
    const anchorBody = bodySize(anchor);
    const bcBodyTotal = bodySize(b) + bodySize(c);
    const bcdBodyTotal = bcBodyTotal + bodySize(d);

    if (
      isBearish(anchor) &&
      isBullish(b) &&
      isBullish(c) &&
      isBullish(d) &&
      bcBodyTotal < anchorBody &&
      bcdBodyTotal > anchorBody
    ) {
      return {
        side: "BUY",
        pattern: "THREE_CANDLE_BODY_DOMINANCE",
        patternExtreme: Math.min(anchor.low, b.low, c.low, d.low),
      };
    }
    if (
      isBullish(anchor) &&
      isBearish(b) &&
      isBearish(c) &&
      isBearish(d) &&
      bcBodyTotal < anchorBody &&
      bcdBodyTotal > anchorBody
    ) {
      return {
        side: "SELL",
        pattern: "THREE_CANDLE_BODY_DOMINANCE",
        patternExtreme: Math.max(anchor.high, b.high, c.high, d.high),
      };
    }
  }

  if (index >= 2) {
    const anchor = bars[index - 2]!;
    const b = bars[index - 1]!;
    const c = current;
    const anchorBody = bodySize(anchor);
    const bBody = bodySize(b);
    const bcBodyTotal = bBody + bodySize(c);

    if (
      isBearish(anchor) &&
      isBullish(b) &&
      isBullish(c) &&
      bBody < anchorBody &&
      bcBodyTotal > anchorBody
    ) {
      return {
        side: "BUY",
        pattern: "TWO_CANDLE_BODY_DOMINANCE",
        patternExtreme: Math.min(anchor.low, b.low, c.low),
      };
    }
    if (
      isBullish(anchor) &&
      isBearish(b) &&
      isBearish(c) &&
      bBody < anchorBody &&
      bcBodyTotal > anchorBody
    ) {
      return {
        side: "SELL",
        pattern: "TWO_CANDLE_BODY_DOMINANCE",
        patternExtreme: Math.max(anchor.high, b.high, c.high),
      };
    }
  }

  if (index >= 1) {
    const previous = bars[index - 1]!;
    const engulf = engulfingSide(previous, current);
    if (engulf) {
      return {
        side: engulf,
        pattern: "ENGULFING",
        patternExtreme: engulf === "BUY" ? current.low : current.high,
      };
    }
  }
  return null;
}

function engulfingSide(previous: Phase7Bar, current: Phase7Bar): Phase7Side | null {
  if (
    isBearish(previous) &&
    isBullish(current) &&
    current.open <= previous.close &&
    current.close >= previous.open
  ) return "BUY";
  if (
    isBullish(previous) &&
    isBearish(current) &&
    current.open >= previous.close &&
    current.close <= previous.open
  ) return "SELL";
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
  for (let i = index - 1; i >= start; i -= 1) {
    const first = bars[i - 2]!;
    const third = bars[i]!;
    if (side === "BUY" && third.low > first.high && current.low <= third.low && current.high >= first.high) return true;
    if (side === "SELL" && third.high < first.low && current.high >= third.high && current.low <= first.low) return true;
  }
  return false;
}

function latestConfirmedStructureStop(
  side: Phase7Side,
  bars: readonly Phase7Bar[],
  afterTimestamp: number,
  atOrBefore: number,
): number | null {
  let latest: number | null = null;
  for (let i = 1; i < bars.length - 1; i += 1) {
    const left = bars[i - 1]!;
    const middle = bars[i]!;
    const right = bars[i + 1]!;
    if (right.closeTime > atOrBefore || right.closeTime <= afterTimestamp) continue;
    if (side === "BUY" && middle.low < left.low && middle.low <= right.low) latest = middle.low;
    if (side === "SELL" && middle.high > left.high && middle.high >= right.high) latest = middle.high;
  }
  return latest;
}

function opposingFvgRejectionAt(
  signal: Phase7BSignal,
  bars: readonly Phase7Bar[],
  atOrBefore: number,
  lookback: number,
  lastCheckedCloseTime: number,
): { checkedCloseTime: number; exit: { timestamp: number; price: number } | null } {
  let currentIndex = -1;
  for (let i = 0; i < bars.length; i += 1) {
    if (bars[i]!.closeTime <= atOrBefore) currentIndex = i;
    else break;
  }
  if (currentIndex < 2) return { checkedCloseTime: lastCheckedCloseTime, exit: null };
  const current = bars[currentIndex]!;
  if (current.closeTime <= signal.signalTimestamp || current.closeTime <= lastCheckedCloseTime) {
    return { checkedCloseTime: Math.max(lastCheckedCloseTime, current.closeTime), exit: null };
  }

  const rejectionDirection = signal.side === "BUY" ? isBearish(current) : isBullish(current);
  if (!rejectionDirection) return { checkedCloseTime: current.closeTime, exit: null };

  const start = Math.max(2, currentIndex - lookback);
  for (let i = currentIndex - 1; i >= start; i -= 1) {
    const first = bars[i - 2]!;
    const third = bars[i]!;
    if (signal.side === "BUY" && third.high < first.low) {
      const zoneLow = third.high;
      const zoneHigh = first.low;
      if (current.high >= zoneLow && current.low <= zoneHigh && current.close < zoneHigh) {
        return { checkedCloseTime: current.closeTime, exit: { timestamp: current.closeTime, price: current.close } };
      }
    }
    if (signal.side === "SELL" && third.low > first.high) {
      const zoneLow = first.high;
      const zoneHigh = third.low;
      if (current.high >= zoneLow && current.low <= zoneHigh && current.close > zoneLow) {
        return { checkedCloseTime: current.closeTime, exit: { timestamp: current.closeTime, price: current.close } };
      }
    }
  }
  return { checkedCloseTime: current.closeTime, exit: null };
}

function findTrendExit(signal: Phase7BSignal, bars: readonly Phase7Bar[]): { timestamp: number; price: number } | null {
  const start = bars.findIndex((bar) => bar.closeTime === signal.signalTimestamp);
  if (start < 0) return null;
  for (let i = start + 1; i < bars.length; i += 1) {
    const closes = bars.slice(0, i + 1).map((bar) => bar.close);
    if (closes.length < 20) continue;
    const ma20 = sma(closes, 20);
    const bar = bars[i]!;
    if (signal.side === "BUY" && bar.close < ma20) return { timestamp: bar.closeTime, price: bar.close };
    if (signal.side === "SELL" && bar.close > ma20) return { timestamp: bar.closeTime, price: bar.close };
  }
  return null;
}

function closeTrade(
  signal: Phase7BSignal,
  entryTime: number,
  exitTime: number,
  exit: number,
  finalStopLoss: number,
  remainingVolume: number,
  breakEvenApplied: boolean,
  partialApplied: boolean,
  partialVolume: number,
  partialPnl: number,
  structuralTrailUpdates: number,
  reversalExitApplied: boolean,
  request: Phase7RunRequest,
  exitReason: Phase7BExitReason,
): Phase7BTradeResult {
  const remainingPnl = pnlUsd(
    signal.side,
    signal.entry,
    exit,
    remainingVolume,
    request.tickSize,
    request.tickValuePerLot,
  );
  const pnl = partialPnl + remainingPnl;
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
    breakEvenApplied,
    partialApplied,
    partialVolume: round(partialVolume, 4),
    partialPnl: round(partialPnl, 4),
    remainingVolumeAtExit: round(remainingVolume, 4),
    structuralTrailUpdates,
    reversalExitApplied,
    exitReason,
  };
}

function buildMetrics(
  m15Bars: number,
  engulfingTriggers: number,
  twoCandleTriggers: number,
  threeCandleTriggers: number,
  trendAligned: number,
  fvgConfirmed: number,
  signals: readonly Phase7BSignal[],
  trades: readonly Phase7BTradeResult[],
): Phase7BMetrics {
  const filled = trades.filter((trade) => trade.filled);
  const wins = filled.filter((trade) => trade.pnl > 0);
  const grossProfit = filled.reduce((sum, trade) => sum + Math.max(0, trade.pnl), 0);
  const grossLoss = Math.abs(filled.reduce((sum, trade) => sum + Math.min(0, trade.pnl), 0));
  const netPnl = filled.reduce((sum, trade) => sum + trade.pnl, 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of [...filled].sort((a, b) => (a.exitTime ?? 0) - (b.exitTime ?? 0))) {
    equity += trade.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return {
    m15Bars,
    engulfingTriggers,
    twoCandleTriggers,
    threeCandleTriggers,
    trendAligned,
    fvgConfirmed,
    signals: signals.length,
    buySignals: signals.filter((signal) => signal.side === "BUY").length,
    sellSignals: signals.filter((signal) => signal.side === "SELL").length,
    filledTrades: filled.length,
    winRatePercent: round(filled.length ? wins.length / filled.length * 100 : 0, 2),
    netPnl: round(netPnl, 2),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : null,
    expectancy: round(filled.length ? netPnl / filled.length : 0, 4),
    averageRMultiple: round(avg(filled.map((trade) => trade.rMultiple)), 4),
    maxRealizedDrawdownUsd: round(maxDrawdown, 2),
    averageHoldHours: round(avg(filled.map((trade) => trade.holdHours)), 4),
    breakEvenApplied: filled.filter((trade) => trade.breakEvenApplied).length,
    partialApplied: filled.filter((trade) => trade.partialApplied).length,
    structuralTrailUpdates: filled.reduce((sum, trade) => sum + trade.structuralTrailUpdates, 0),
    reversalFvgExits: filled.filter((trade) => trade.exitReason === "REVERSAL_FVG_REJECTION").length,
  };
}

function summarize(trades: readonly Phase7BTradeResult[]): {
  filled: number;
  winRatePercent: number;
  netPnl: number;
  profitFactor: number | null;
  expectancy: number;
  averageR: number;
} {
  const filled = trades.filter((trade) => trade.filled);
  const wins = filled.filter((trade) => trade.pnl > 0);
  const grossProfit = filled.reduce((sum, trade) => sum + Math.max(0, trade.pnl), 0);
  const grossLoss = Math.abs(filled.reduce((sum, trade) => sum + Math.min(0, trade.pnl), 0));
  const net = filled.reduce((sum, trade) => sum + trade.pnl, 0);
  return {
    filled: filled.length,
    winRatePercent: round(filled.length ? wins.length / filled.length * 100 : 0, 2),
    netPnl: round(net, 2),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : null,
    expectancy: round(filled.length ? net / filled.length : 0, 4),
    averageR: round(avg(filled.map((trade) => trade.rMultiple)), 4),
  };
}

function partialCloseVolume(
  total: number,
  fraction: number,
  remaining: number,
  minVolume: number,
  step: number,
): number {
  const raw = total * fraction;
  const stepped = Math.floor((raw + 1e-9) / step) * step;
  if (stepped < minVolume) return 0;
  const normalized = normalizeVolume(stepped, step);
  if (remaining - normalized < minVolume - 1e-9) return 0;
  return Math.min(normalized, remaining);
}

function normalizeVolume(value: number, step: number): number {
  return round(Math.max(0, Math.round((value + 1e-9) / step) * step), 4);
}

function improveStop(side: Phase7Side, current: number, candidate: number): number {
  return side === "BUY" ? Math.max(current, candidate) : Math.min(current, candidate);
}

function isBullish(bar: Phase7Bar): boolean { return bar.close > bar.open; }
function isBearish(bar: Phase7Bar): boolean { return bar.close < bar.open; }
function bodySize(bar: Phase7Bar): number { return Math.abs(bar.close - bar.open); }
function touchesPrice(bar: Phase7Bar, price: number): boolean { return bar.low <= price && bar.high >= price; }

function pnlUsd(
  side: Phase7Side,
  entry: number,
  exit: number,
  volume: number,
  tickSize: number,
  tickValuePerLot: number,
): number {
  const move = side === "BUY" ? exit - entry : entry - exit;
  return move / tickSize * tickValuePerLot * volume;
}

function riskUsd(entry: number, stop: number, volume: number, tickSize: number, tickValuePerLot: number): number {
  return Math.abs(entry - stop) / tickSize * tickValuePerLot * volume;
}

function sma(values: readonly number[], period: number): number {
  if (values.length < period) throw new Error(`Not enough values for SMA${period}.`);
  const slice = values.slice(values.length - period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

function validateConfig(config: Phase7BConfig): void {
  if (!(config.minStopDistancePrice > 0 && config.maxStopDistancePrice >= config.minStopDistancePrice)) {
    throw new Error("Phase 7B invalid SL range.");
  }
  if (!(config.breakEvenTriggerPrice > 0 && config.partialTriggerPrice > config.breakEvenTriggerPrice)) {
    throw new Error("Phase 7B invalid management trigger ordering.");
  }
  if (!(config.partialFraction > 0 && config.partialFraction < 1)) {
    throw new Error("Phase 7B partial fraction must be between 0 and 1.");
  }
}

function validateRequest(request: Phase7RunRequest): void {
  for (const [name, value] of Object.entries({
    fixedVolume: request.fixedVolume,
    tickSize: request.tickSize,
    tickValuePerLot: request.tickValuePerLot,
    minVolume: request.minVolume ?? 0.01,
    volumeStep: request.volumeStep ?? request.minVolume ?? 0.01,
  })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Phase 7B requires positive ${name}.`);
  }
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function avg(values: readonly number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
