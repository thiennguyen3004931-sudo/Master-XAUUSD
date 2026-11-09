import fs from "node:fs";
import type { Phase7Bar } from "@xauusd/risk-engine";

type Side = "BUY" | "SELL";
type Pattern = "ENGULFING" | "TWO_CANDLE_BODY_DOMINANCE";
type ExitReason = "ENTRY_NOT_FILLED" | "STOP" | "TREND_MA20" | "REVERSAL_FVG_REJECTION" | "END_OF_DATA";

type Meta = Record<string, unknown> & {
  tickSize?: number;
  effectiveTickValuePerLot?: number;
  minVolume?: number;
  volumeStep?: number;
};

type Signal = {
  id: string;
  side: Side;
  pattern: Pattern;
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
  fvgConfirmedAtEntry: boolean;
};

type Trade = Signal & {
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
  exitReason: ExitReason;
};

type Arm = {
  key: "CURRENT_FVG_OPTIONAL" | "PREVIOUS_FVG_MANDATORY";
  requireFvgAtEntry: boolean;
  signals: Signal[];
  rawTrades: Trade[];
  selectedTrades: Trade[];
  skippedWhilePositionOpen: number;
};

type Metrics = {
  key: Arm["key"];
  requireFvgAtEntry: boolean;
  signals: number;
  fvgConfirmedSignals: number;
  buySignals: number;
  sellSignals: number;
  rawFilledTrades: number;
  maxOnePositionTrades: number;
  skippedWhilePositionOpen: number;
  tradesPerTradingDay: number;
  winRatePercent: number;
  netPnl: number;
  profitFactor: number | null;
  expectancy: number;
  averageR: number;
  maxDrawdownUsd: number;
  averageHoldHours: number;
  breakEvenApplied: number;
  partialApplied: number;
  structuralTrailUpdates: number;
  reversalFvgExits: number;
  buy: SliceMetrics;
  sell: SliceMetrics;
  engulfing: SliceMetrics;
  twoCandle: SliceMetrics;
};

type SliceMetrics = {
  filled: number;
  winRatePercent: number;
  netPnl: number;
  profitFactor: number | null;
  expectancy: number;
  averageR: number;
};

const M15_MIN_HISTORY = 200;
const FVG_LOOKBACK = 12;
const REVERSAL_FVG_LOOKBACK = 48;
const ENTRY_EXPIRY_MS = 15 * 60_000;
const MIN_STOP = 6;
const MAX_STOP = 10;
const BREAK_EVEN_TRIGGER = 6;
const PARTIAL_TRIGGER = 10;
const PARTIAL_FRACTION = 1 / 3;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T;
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const m15Path = requiredEnv("ZIQ_M15_JSON");
const m5Path = requiredEnv("ZIQ_M5_JSON");
const metaPath = requiredEnv("ZIQ_META_JSON");
const summaryCsvPath = requiredEnv("ZIQ_PHASE7B_FVG_AB_SUMMARY_CSV");
const summaryJsonPath = requiredEnv("ZIQ_PHASE7B_FVG_AB_SUMMARY_JSON");
const currentTradesPath = requiredEnv("ZIQ_PHASE7B_FVG_AB_CURRENT_TRADES_CSV");
const previousTradesPath = requiredEnv("ZIQ_PHASE7B_FVG_AB_PREVIOUS_TRADES_CSV");
const fixedVolume = Number(process.env.ZIQ_FIXED_VOLUME ?? "0.03");

const m15 = readJson<Phase7Bar[]>(m15Path).sort((a, b) => a.openTime - b.openTime);
const m5 = readJson<Phase7Bar[]>(m5Path).sort((a, b) => a.openTime - b.openTime);
const meta = readJson<Meta>(metaPath);
const tickSize = Number(meta.tickSize);
const tickValuePerLot = Number(meta.effectiveTickValuePerLot);
const minVolume = Number(meta.minVolume ?? 0.01);
const volumeStep = Number(meta.volumeStep ?? minVolume);

if (m15.length <= M15_MIN_HISTORY || m5.length === 0) throw new Error("Historical M15/M5 inputs are insufficient.");
if (![fixedVolume, tickSize, tickValuePerLot, minVolume, volumeStep].every((value) => Number.isFinite(value) && value > 0)) {
  throw new Error("Historical metadata/fixed-volume inputs are invalid.");
}

const ma20 = rollingSma(m15.map((bar) => bar.close), 20);
const ma50 = rollingSma(m15.map((bar) => bar.close), 50);
const ma200 = rollingSma(m15.map((bar) => bar.close), 200);
const closeTimes = m15.map((bar) => bar.closeTime);
const swingLows = buildConfirmedSwings(m15, "BUY");
const swingHighs = buildConfirmedSwings(m15, "SELL");
const tradingDays = new Set(m15.map((bar) => new Date(bar.closeTime).toISOString().slice(0, 10))).size;

const current = runArm("CURRENT_FVG_OPTIONAL", false);
const previous = runArm("PREVIOUS_FVG_MANDATORY", true);
const currentMetrics = metrics(current);
const previousMetrics = metrics(previous);
const delta = buildDelta(currentMetrics, previousMetrics);

console.log("PHASE7B_FVG_AB_COMPARISON=START");
console.log("PHASE7B_FVG_AB_ISOLATED_VARIABLE=FVG_ENTRY_GATE_ONLY");
console.log("PHASE7B_FVG_AB_TWO_CANDLE_RULE=FIRST_BODY_LT_PREVIOUS_OPPOSITE_BODY_AND_SUM_TWO_GT_PREVIOUS_OPPOSITE_BODY");
console.log("PHASE7B_FVG_AB_MA=MA20_MA50_MA200_MANDATORY_BOTH_ARMS");
console.log("PHASE7B_FVG_AB_FVG_CURRENT=OPTIONAL_AT_ENTRY");
console.log("PHASE7B_FVG_AB_FVG_PREVIOUS=MANDATORY_SAME_DIRECTION_AT_ENTRY");
console.log("PHASE7B_FVG_AB_MAX_MANAGED_POSITIONS=1_ENFORCED_IN_PRIMARY_METRICS");
console.log("PHASE7B_FVG_AB_MANAGEMENT=SAME_BOTH_ARMS|SL_6_10|PLUS6_BE|PLUS10_PARTIAL_1_3|M15_STRUCTURE|REVERSAL_FVG_REJECTION|MA20_EXIT");
console.log(`PHASE7B_FVG_AB_M15_BARS=${m15.length}`);
console.log(`PHASE7B_FVG_AB_M5_BARS=${m5.length}`);
console.log(`PHASE7B_FVG_AB_TRADING_DAYS=${tradingDays}`);
console.log(`PHASE7B_FVG_AB_DATA_START=${new Date(m15[0]!.openTime).toISOString()}`);
console.log(`PHASE7B_FVG_AB_DATA_END=${new Date(m15.at(-1)!.closeTime).toISOString()}`);
printMetrics("CURRENT", currentMetrics);
printMetrics("PREVIOUS_FVG", previousMetrics);
console.log(`PHASE7B_FVG_AB_DELTA_TRADES=${delta.maxOnePositionTrades}`);
console.log(`PHASE7B_FVG_AB_DELTA_TRADES_PER_DAY=${delta.tradesPerTradingDay}`);
console.log(`PHASE7B_FVG_AB_DELTA_WIN_RATE_PP=${delta.winRatePercent}`);
console.log(`PHASE7B_FVG_AB_DELTA_NET_PNL=${delta.netPnl}`);
console.log(`PHASE7B_FVG_AB_DELTA_PROFIT_FACTOR=${delta.profitFactor ?? "NA"}`);
console.log(`PHASE7B_FVG_AB_DELTA_EXPECTANCY=${delta.expectancy}`);
console.log(`PHASE7B_FVG_AB_DELTA_AVG_R=${delta.averageR}`);
console.log(`PHASE7B_FVG_AB_DELTA_MAX_DRAWDOWN_USD=${delta.maxDrawdownUsd}`);
console.log("PHASE7B_FVG_AB_VALIDATION=RESEARCH_REPLAY_NOT_INDEPENDENT_HOLDOUT");
console.log("PHASE7B_FVG_AB_PRODUCTION_MUTATION=false");

writeSummaryCsv([currentMetrics, previousMetrics], summaryCsvPath);
fs.writeFileSync(summaryJsonPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  data: {
    m15Path,
    m5Path,
    metaPath,
    m15Bars: m15.length,
    m5Bars: m5.length,
    tradingDays,
    start: new Date(m15[0]!.openTime).toISOString(),
    end: new Date(m15.at(-1)!.closeTime).toISOString(),
  },
  isolatedVariable: "FVG_ENTRY_GATE_ONLY",
  commonRules: {
    pattern: "ENGULFING_OR_REFINED_TWO_CANDLE_BODY_DOMINANCE",
    twoCandle: "FIRST_BODY_LT_PREVIOUS_OPPOSITE_BODY_AND_SUM_TWO_GT_PREVIOUS_OPPOSITE_BODY",
    trend: "MA20_MA50_MA200_MANDATORY",
    initialStop: "CLAMP_6_TO_10_PRICE",
    plus6: "SL_TO_ENTRY",
    plus10: "PARTIAL_ONE_THIRD",
    runner: "M15_CONFIRMED_STRUCTURE_ONLY_TIGHTEN",
    reversalExit: "OPPOSING_FVG_PLUS_REJECTION_AFTER_PLUS10",
    fallbackExit: "MA20_REVERSAL",
    maxManagedPositions: 1,
    fixedVolume,
  },
  current: currentMetrics,
  previousFvgMandatory: previousMetrics,
  deltaCurrentMinusPrevious: delta,
}, null, 2)}\n`, "utf8");
writeTrades(current.selectedTrades, currentTradesPath);
writeTrades(previous.selectedTrades, previousTradesPath);
console.log(`PHASE7B_FVG_AB_SUMMARY_CSV=${summaryCsvPath}`);
console.log(`PHASE7B_FVG_AB_SUMMARY_JSON=${summaryJsonPath}`);
console.log(`PHASE7B_FVG_AB_CURRENT_TRADES_CSV=${currentTradesPath}`);
console.log(`PHASE7B_FVG_AB_PREVIOUS_TRADES_CSV=${previousTradesPath}`);
console.log("PHASE7B_FVG_AB_COMPARISON=PASS");

function runArm(key: Arm["key"], requireFvgAtEntry: boolean): Arm {
  const signals: Signal[] = [];
  for (let index = M15_MIN_HISTORY; index < m15.length; index += 1) {
    const trigger = detectPattern(m15, index);
    if (!trigger) continue;
    const current = m15[index]!;
    const a20 = ma20[index];
    const a50 = ma50[index];
    const a200 = ma200[index];
    if (![a20, a50, a200].every((value) => Number.isFinite(value))) continue;
    if (!trendMatches(trigger.side, current.close, a20!, a50!, a200!)) continue;
    const fvgConfirmedAtEntry = hasRelevantFvg(m15, index, trigger.side, FVG_LOOKBACK);
    if (requireFvgAtEntry && !fvgConfirmedAtEntry) continue;

    const entry = current.close;
    const structuralStopDistance = trigger.side === "BUY" ? entry - trigger.patternExtreme : trigger.patternExtreme - entry;
    if (!(structuralStopDistance > 0)) continue;
    const stopDistance = clamp(structuralStopDistance, MIN_STOP, MAX_STOP);
    const stopLoss = trigger.side === "BUY" ? entry - stopDistance : entry + stopDistance;
    const initialRiskUsd = riskUsd(entry, stopLoss, fixedVolume, tickSize, tickValuePerLot);
    signals.push({
      id: `phase7b-ab-${current.closeTime}-${trigger.side}-${trigger.pattern}`,
      side: trigger.side,
      pattern: trigger.pattern,
      signalTimestamp: current.closeTime,
      entry: round(entry, 5),
      patternExtreme: round(trigger.patternExtreme, 5),
      structuralStopDistance: round(structuralStopDistance, 5),
      stopDistance: round(stopDistance, 5),
      stopLoss: round(stopLoss, 5),
      volume: round(fixedVolume, 4),
      initialRiskUsd: round(initialRiskUsd, 4),
      ma20: round(a20!, 5),
      ma50: round(a50!, 5),
      ma200: round(a200!, 5),
      fvgConfirmedAtEntry,
    });
  }

  const rawTrades = signals.map(simulate);
  const selectedTrades: Trade[] = [];
  let busyUntil = -Infinity;
  let skippedWhilePositionOpen = 0;
  for (const trade of [...rawTrades].sort((a, b) => a.signalTimestamp - b.signalTimestamp)) {
    if (trade.signalTimestamp < busyUntil) {
      skippedWhilePositionOpen += 1;
      continue;
    }
    if (!trade.filled) continue;
    selectedTrades.push(trade);
    busyUntil = trade.exitTime ?? Number.POSITIVE_INFINITY;
  }
  return { key, requireFvgAtEntry, signals, rawTrades, selectedTrades, skippedWhilePositionOpen };
}

function simulate(signal: Signal): Trade {
  const expiry = signal.signalTimestamp + ENTRY_EXPIRY_MS;
  const trendExit = findTrendExit(signal);
  let entryTime: number | null = null;
  let activeStop = signal.stopLoss;
  let remainingVolume = signal.volume;
  let breakEvenApplied = false;
  let plus10Activated = false;
  let partialApplied = false;
  let partialVolume = 0;
  let partialPnl = 0;
  let structuralTrailUpdates = 0;
  let lastReversalM15CloseChecked = signal.signalTimestamp;
  const startIndex = lowerBound(m5.map((bar) => bar.openTime), signal.signalTimestamp);

  for (let i = startIndex; i < m5.length; i += 1) {
    const bar = m5[i]!;
    if (entryTime === null) {
      if (bar.openTime > expiry) break;
      if (!touchesPrice(bar, signal.entry)) continue;
      entryTime = bar.openTime;
    }

    if (touchesPrice(bar, activeStop)) {
      return closeTrade(signal, entryTime, bar.closeTime, activeStop, activeStop, remainingVolume, breakEvenApplied,
        partialApplied, partialVolume, partialPnl, structuralTrailUpdates, false, "STOP");
    }

    const favorable = signal.side === "BUY" ? bar.high - signal.entry : signal.entry - bar.low;
    if (!breakEvenApplied && favorable >= BREAK_EVEN_TRIGGER) {
      activeStop = improveStop(signal.side, activeStop, signal.entry);
      breakEvenApplied = true;
    }

    if (!plus10Activated && favorable >= PARTIAL_TRIGGER) {
      plus10Activated = true;
      const closeVolume = partialCloseVolume(signal.volume, PARTIAL_FRACTION, remainingVolume, minVolume, volumeStep);
      if (closeVolume > 0) {
        const triggerPrice = signal.side === "BUY" ? signal.entry + PARTIAL_TRIGGER : signal.entry - PARTIAL_TRIGGER;
        partialApplied = true;
        partialVolume = closeVolume;
        partialPnl = pnlUsd(signal.side, signal.entry, triggerPrice, closeVolume, tickSize, tickValuePerLot);
        remainingVolume = normalizeVolume(remainingVolume - closeVolume, volumeStep);
      }
    }

    if (plus10Activated) {
      const structure = latestConfirmedStructure(signal.side, signal.signalTimestamp, bar.closeTime);
      if (structure !== null) {
        const improved = improveStop(signal.side, activeStop, structure);
        if (Math.abs(improved - activeStop) > 1e-9) structuralTrailUpdates += 1;
        activeStop = improved;
      }

      const currentM15Index = upperBound(closeTimes, bar.closeTime) - 1;
      if (currentM15Index >= 2) {
        const currentM15 = m15[currentM15Index]!;
        if (currentM15.closeTime > lastReversalM15CloseChecked && currentM15.closeTime > signal.signalTimestamp) {
          lastReversalM15CloseChecked = currentM15.closeTime;
          if (opposingFvgRejectionAt(signal.side, currentM15Index, REVERSAL_FVG_LOOKBACK)) {
            return closeTrade(signal, entryTime, currentM15.closeTime, currentM15.close, activeStop, remainingVolume,
              breakEvenApplied, partialApplied, partialVolume, partialPnl, structuralTrailUpdates, true,
              "REVERSAL_FVG_REJECTION");
          }
        }
      }
    }

    if (trendExit !== null && bar.closeTime >= trendExit.timestamp) {
      return closeTrade(signal, entryTime, trendExit.timestamp, trendExit.price, activeStop, remainingVolume,
        breakEvenApplied, partialApplied, partialVolume, partialPnl, structuralTrailUpdates, false, "TREND_MA20");
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

  const last = m5.at(-1)!;
  return closeTrade(signal, entryTime, last.closeTime, last.close, activeStop, remainingVolume, breakEvenApplied,
    partialApplied, partialVolume, partialPnl, structuralTrailUpdates, false, "END_OF_DATA");
}

function detectPattern(bars: readonly Phase7Bar[], index: number): { side: Side; pattern: Pattern; patternExtreme: number } | null {
  const current = bars[index]!;
  const previous = bars[index - 1]!;
  if (isBearish(previous) && isBullish(current) && current.open <= previous.close && current.close >= previous.open) {
    return { side: "BUY", pattern: "ENGULFING", patternExtreme: current.low };
  }
  if (isBullish(previous) && isBearish(current) && current.open >= previous.close && current.close <= previous.open) {
    return { side: "SELL", pattern: "ENGULFING", patternExtreme: current.high };
  }
  if (index < 2) return null;
  const priorOpposite = bars[index - 2]!;
  const first = bars[index - 1]!;
  const priorBody = bodySize(priorOpposite);
  const firstBody = bodySize(first);
  const combinedBody = firstBody + bodySize(current);
  if (isBearish(priorOpposite) && isBullish(first) && isBullish(current) && firstBody < priorBody && combinedBody > priorBody) {
    return { side: "BUY", pattern: "TWO_CANDLE_BODY_DOMINANCE", patternExtreme: Math.min(priorOpposite.low, first.low, current.low) };
  }
  if (isBullish(priorOpposite) && isBearish(first) && isBearish(current) && firstBody < priorBody && combinedBody > priorBody) {
    return { side: "SELL", pattern: "TWO_CANDLE_BODY_DOMINANCE", patternExtreme: Math.max(priorOpposite.high, first.high, current.high) };
  }
  return null;
}

function trendMatches(side: Side, close: number, a20: number, a50: number, a200: number): boolean {
  return side === "BUY" ? a20 > a50 && a50 > a200 && close > a20 : a20 < a50 && a50 < a200 && close < a20;
}

function hasRelevantFvg(bars: readonly Phase7Bar[], index: number, side: Side, lookback: number): boolean {
  if (index < 2) return false;
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

function opposingFvgRejectionAt(side: Side, currentIndex: number, lookback: number): boolean {
  const current = m15[currentIndex]!;
  const rejectionDirection = side === "BUY" ? isBearish(current) : isBullish(current);
  if (!rejectionDirection) return false;
  const start = Math.max(2, currentIndex - lookback);
  for (let i = currentIndex - 1; i >= start; i -= 1) {
    const first = m15[i - 2]!;
    const third = m15[i]!;
    if (side === "BUY" && third.high < first.low) {
      const zoneLow = third.high;
      const zoneHigh = first.low;
      if (current.high >= zoneLow && current.low <= zoneHigh && current.close < zoneHigh) return true;
    }
    if (side === "SELL" && third.low > first.high) {
      const zoneLow = first.high;
      const zoneHigh = third.low;
      if (current.high >= zoneLow && current.low <= zoneHigh && current.close > zoneLow) return true;
    }
  }
  return false;
}

function findTrendExit(signal: Signal): { timestamp: number; price: number } | null {
  const start = lowerBound(closeTimes, signal.signalTimestamp);
  for (let i = start + 1; i < m15.length; i += 1) {
    const bar = m15[i]!;
    const a20 = ma20[i];
    if (!Number.isFinite(a20)) continue;
    if (signal.side === "BUY" && bar.close < a20!) return { timestamp: bar.closeTime, price: bar.close };
    if (signal.side === "SELL" && bar.close > a20!) return { timestamp: bar.closeTime, price: bar.close };
  }
  return null;
}

function buildConfirmedSwings(bars: readonly Phase7Bar[], side: Side): Array<{ confirmedAt: number; level: number }> {
  const result: Array<{ confirmedAt: number; level: number }> = [];
  for (let i = 1; i < bars.length - 1; i += 1) {
    const left = bars[i - 1]!;
    const middle = bars[i]!;
    const right = bars[i + 1]!;
    if (side === "BUY" && middle.low < left.low && middle.low <= right.low) result.push({ confirmedAt: right.closeTime, level: middle.low });
    if (side === "SELL" && middle.high > left.high && middle.high >= right.high) result.push({ confirmedAt: right.closeTime, level: middle.high });
  }
  return result;
}

function latestConfirmedStructure(side: Side, afterTimestamp: number, atOrBefore: number): number | null {
  const swings = side === "BUY" ? swingLows : swingHighs;
  let index = upperBound(swings.map((item) => item.confirmedAt), atOrBefore) - 1;
  while (index >= 0) {
    const item = swings[index]!;
    if (item.confirmedAt <= afterTimestamp) return null;
    return item.level;
  }
  return null;
}

function closeTrade(signal: Signal, entryTime: number, exitTime: number, exit: number, finalStopLoss: number,
  remainingVolume: number, breakEvenApplied: boolean, partialApplied: boolean, partialVolume: number,
  partialPnl: number, structuralTrailUpdates: number, reversalExitApplied: boolean, exitReason: ExitReason): Trade {
  const remainingPnl = pnlUsd(signal.side, signal.entry, exit, remainingVolume, tickSize, tickValuePerLot);
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

function metrics(arm: Arm): Metrics {
  const trades = arm.selectedTrades;
  const summary = summarize(trades);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of [...trades].sort((a, b) => (a.exitTime ?? 0) - (b.exitTime ?? 0))) {
    equity += trade.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return {
    key: arm.key,
    requireFvgAtEntry: arm.requireFvgAtEntry,
    signals: arm.signals.length,
    fvgConfirmedSignals: arm.signals.filter((signal) => signal.fvgConfirmedAtEntry).length,
    buySignals: arm.signals.filter((signal) => signal.side === "BUY").length,
    sellSignals: arm.signals.filter((signal) => signal.side === "SELL").length,
    rawFilledTrades: arm.rawTrades.filter((trade) => trade.filled).length,
    maxOnePositionTrades: trades.length,
    skippedWhilePositionOpen: arm.skippedWhilePositionOpen,
    tradesPerTradingDay: round(tradingDays > 0 ? trades.length / tradingDays : 0, 4),
    winRatePercent: summary.winRatePercent,
    netPnl: summary.netPnl,
    profitFactor: summary.profitFactor,
    expectancy: summary.expectancy,
    averageR: summary.averageR,
    maxDrawdownUsd: round(maxDrawdown, 2),
    averageHoldHours: round(avg(trades.map((trade) => trade.holdHours)), 4),
    breakEvenApplied: trades.filter((trade) => trade.breakEvenApplied).length,
    partialApplied: trades.filter((trade) => trade.partialApplied).length,
    structuralTrailUpdates: trades.reduce((sum, trade) => sum + trade.structuralTrailUpdates, 0),
    reversalFvgExits: trades.filter((trade) => trade.exitReason === "REVERSAL_FVG_REJECTION").length,
    buy: summarize(trades.filter((trade) => trade.side === "BUY")),
    sell: summarize(trades.filter((trade) => trade.side === "SELL")),
    engulfing: summarize(trades.filter((trade) => trade.pattern === "ENGULFING")),
    twoCandle: summarize(trades.filter((trade) => trade.pattern === "TWO_CANDLE_BODY_DOMINANCE")),
  };
}

function summarize(trades: readonly Trade[]): SliceMetrics {
  const filled = trades.filter((trade) => trade.filled);
  const wins = filled.filter((trade) => trade.pnl > 0);
  const grossProfit = filled.reduce((sum, trade) => sum + Math.max(0, trade.pnl), 0);
  const grossLoss = Math.abs(filled.reduce((sum, trade) => sum + Math.min(0, trade.pnl), 0));
  const netPnl = filled.reduce((sum, trade) => sum + trade.pnl, 0);
  return {
    filled: filled.length,
    winRatePercent: round(filled.length ? wins.length / filled.length * 100 : 0, 2),
    netPnl: round(netPnl, 2),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : null,
    expectancy: round(filled.length ? netPnl / filled.length : 0, 4),
    averageR: round(avg(filled.map((trade) => trade.rMultiple)), 4),
  };
}

function buildDelta(current: Metrics, previous: Metrics) {
  return {
    signals: current.signals - previous.signals,
    maxOnePositionTrades: current.maxOnePositionTrades - previous.maxOnePositionTrades,
    tradesPerTradingDay: round(current.tradesPerTradingDay - previous.tradesPerTradingDay, 4),
    winRatePercent: round(current.winRatePercent - previous.winRatePercent, 2),
    netPnl: round(current.netPnl - previous.netPnl, 2),
    profitFactor: current.profitFactor !== null && previous.profitFactor !== null ? round(current.profitFactor - previous.profitFactor, 4) : null,
    expectancy: round(current.expectancy - previous.expectancy, 4),
    averageR: round(current.averageR - previous.averageR, 4),
    maxDrawdownUsd: round(current.maxDrawdownUsd - previous.maxDrawdownUsd, 2),
  };
}

function printMetrics(prefix: string, m: Metrics): void {
  console.log(`PHASE7B_FVG_AB_${prefix}_SIGNALS=${m.signals}`);
  console.log(`PHASE7B_FVG_AB_${prefix}_FVG_CONFIRMED_SIGNALS=${m.fvgConfirmedSignals}`);
  console.log(`PHASE7B_FVG_AB_${prefix}_RAW_FILLED=${m.rawFilledTrades}`);
  console.log(`PHASE7B_FVG_AB_${prefix}_MAX1_TRADES=${m.maxOnePositionTrades}`);
  console.log(`PHASE7B_FVG_AB_${prefix}_TRADES_PER_TRADING_DAY=${m.tradesPerTradingDay}`);
  console.log(`PHASE7B_FVG_AB_${prefix}_WIN_RATE=${m.winRatePercent}`);
  console.log(`PHASE7B_FVG_AB_${prefix}_NET_PNL=${m.netPnl}`);
  console.log(`PHASE7B_FVG_AB_${prefix}_PROFIT_FACTOR=${m.profitFactor ?? "INF"}`);
  console.log(`PHASE7B_FVG_AB_${prefix}_EXPECTANCY=${m.expectancy}`);
  console.log(`PHASE7B_FVG_AB_${prefix}_AVG_R=${m.averageR}`);
  console.log(`PHASE7B_FVG_AB_${prefix}_MAX_DRAWDOWN_USD=${m.maxDrawdownUsd}`);
  console.log(`PHASE7B_FVG_AB_${prefix}_BUY=FILLED=${m.buy.filled}|WR=${m.buy.winRatePercent}|NET=${m.buy.netPnl}|PF=${m.buy.profitFactor ?? "INF"}|EXP=${m.buy.expectancy}|AVG_R=${m.buy.averageR}`);
  console.log(`PHASE7B_FVG_AB_${prefix}_SELL=FILLED=${m.sell.filled}|WR=${m.sell.winRatePercent}|NET=${m.sell.netPnl}|PF=${m.sell.profitFactor ?? "INF"}|EXP=${m.sell.expectancy}|AVG_R=${m.sell.averageR}`);
  console.log(`PHASE7B_FVG_AB_${prefix}_ENGULFING=FILLED=${m.engulfing.filled}|WR=${m.engulfing.winRatePercent}|NET=${m.engulfing.netPnl}|PF=${m.engulfing.profitFactor ?? "INF"}`);
  console.log(`PHASE7B_FVG_AB_${prefix}_TWO_CANDLE=FILLED=${m.twoCandle.filled}|WR=${m.twoCandle.winRatePercent}|NET=${m.twoCandle.netPnl}|PF=${m.twoCandle.profitFactor ?? "INF"}`);
}

function writeSummaryCsv(rows: Metrics[], file: string): void {
  const headers = ["key", "requireFvgAtEntry", "signals", "fvgConfirmedSignals", "buySignals", "sellSignals", "rawFilledTrades",
    "maxOnePositionTrades", "skippedWhilePositionOpen", "tradesPerTradingDay", "winRatePercent", "netPnl", "profitFactor",
    "expectancy", "averageR", "maxDrawdownUsd", "averageHoldHours", "breakEvenApplied", "partialApplied",
    "structuralTrailUpdates", "reversalFvgExits"];
  const lines = rows.map((row) => headers.map((header) => csvEscape((row as any)[header])).join(","));
  fs.writeFileSync(file, `${headers.join(",")}\n${lines.join("\n")}\n`, "utf8");
}

function writeTrades(trades: Trade[], file: string): void {
  const headers = ["id", "side", "pattern", "signalTimestamp", "entry", "fvgConfirmedAtEntry", "stopDistance", "stopLoss", "volume",
    "initialRiskUsd", "ma20", "ma50", "ma200", "entryTime", "breakEvenApplied", "partialApplied", "partialVolume", "partialPnl",
    "structuralTrailUpdates", "reversalExitApplied", "finalStopLoss", "exitReason", "exit", "exitTime", "pnl", "rMultiple", "holdHours",
    "remainingVolumeAtExit"];
  const lines = trades.map((trade) => headers.map((header) => csvEscape((trade as any)[header])).join(","));
  fs.writeFileSync(file, `${headers.join(",")}\n${lines.join("\n")}\n`, "utf8");
}

function rollingSma(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) result[i] = sum / period;
  }
  return result;
}

function lowerBound(values: number[], target: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function upperBound(values: number[], target: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! <= target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function isBullish(bar: Phase7Bar): boolean { return bar.close > bar.open; }
function isBearish(bar: Phase7Bar): boolean { return bar.close < bar.open; }
function bodySize(bar: Phase7Bar): number { return Math.abs(bar.close - bar.open); }
function touchesPrice(bar: Phase7Bar, price: number): boolean { return bar.low <= price && bar.high >= price; }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function avg(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function round(value: number, digits: number): number { const factor = 10 ** digits; return Math.round((value + Number.EPSILON) * factor) / factor; }
function improveStop(side: Side, current: number, candidate: number): number { return side === "BUY" ? Math.max(current, candidate) : Math.min(current, candidate); }
function normalizeVolume(value: number, step: number): number { return round(Math.max(0, Math.round((value + 1e-9) / step) * step), 4); }
function partialCloseVolume(total: number, fraction: number, remaining: number, min: number, step: number): number {
  const raw = total * fraction;
  const stepped = Math.floor((raw + 1e-9) / step) * step;
  if (stepped < min) return 0;
  const normalized = normalizeVolume(stepped, step);
  if (remaining - normalized < min - 1e-9) return 0;
  return Math.min(normalized, remaining);
}
function pnlUsd(side: Side, entry: number, exit: number, volume: number, tick: number, tickValue: number): number {
  const move = side === "BUY" ? exit - entry : entry - exit;
  return move / tick * tickValue * volume;
}
function riskUsd(entry: number, stop: number, volume: number, tick: number, tickValue: number): number {
  return Math.abs(entry - stop) / tick * tickValue * volume;
}
