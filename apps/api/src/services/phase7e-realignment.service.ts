import { runPhase7CCanonicalBacktest } from "./phase7c.service";

export type Phase7ERealignmentRequest = {
  from: string;
  to: string;
  fixedVolume?: number;
  atrPeriod?: number;
  multiplier?: number;
};

type Side = "BUY" | "SELL";
type Pattern = "ENGULFING" | "TWO_CANDLE_BODY_DOMINANCE";
type Direction = 1 | -1;
type ExitReason = "STOP" | "TREND_MA20" | "REVERSAL_FVG_REJECTION" | "END_OF_DATA";
type VariantName = "DUAL_STATE" | "M5_FLIP_1" | "M5_FLIP_2" | "M5_FLIP_3";

type Bar = { openTime: number; closeTime: number; open: number; high: number; low: number; close: number; spread: number };
type BridgeHealth = { connected: boolean; accountMode: "demo" | "contest" | "real" | null; accountLogin: number | null; server: string | null };
type Spec = { brokerSymbol: string; tickSize: number; effectiveTickValuePerLot: number; cashPerPriceUnitPerLot: number; digits: number; minVolume: number; maxVolume: number; volumeStep: number };
type Signal = { side: Side; pattern: Pattern; signalTimestamp: number; patternExtreme: number; stopDistance: number; m15Direction: Direction; m5Direction: Direction; m5FlipAgeBars: number | null };
type Trade = Signal & { entryTime: number; entry: number; stopLoss: number; initialRiskUsd: number; volume: number; exitTime: number; exit: number; pnl: number; rMultiple: number; holdHours: number; breakEvenApplied: boolean; partialApplied: boolean; partialVolume: number; partialPnl: number; remainingVolumeAtExit: number; structuralTrailUpdates: number; exitReason: ExitReason };

type Metrics = ReturnType<typeof summarize>;

const DAY_MS = 86_400_000;
const ENGULF_BODY_TOLERANCE_PRICE = 0.1;
const M15_MIN_HISTORY = 200;
const MIN_STOP = 6;
const MAX_STOP = 10;
const BREAK_EVEN_TRIGGER = 6;
const PARTIAL_TRIGGER = 10;
const REVERSAL_FVG_LOOKBACK = 48;
const ENTRY_EXPIRY_MS = 15 * 60_000;
const MAX_RESEARCH_DAYS = 370;

function bridgeBase() { return (process.env.MT5_BRIDGE_BASE_URL ?? "http://127.0.0.1:8765").trim().replace(/\/$/, ""); }
function bridgeApiKey() { const value = process.env.MT5_BRIDGE_API_KEY?.trim() ?? ""; if (!value) throw new Error("MT5_BRIDGE_API_KEY is not configured for Phase 7E realignment research."); return value; }
async function bridgeGet<T>(path: string, timeoutMs = 60_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${bridgeBase()}${path}`, { headers: { "x-mt5-api-key": bridgeApiKey() }, signal: controller.signal, cache: "no-store" });
    const text = await response.text();
    if (!response.ok) throw new Error(`MT5 bridge ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  } finally { clearTimeout(timeout); }
}

export async function runPhase7ERealignmentResearch(input: Phase7ERealignmentRequest) {
  const fixedVolume = finite(input.fixedVolume, 0.03);
  const atrPeriod = Math.trunc(finite(input.atrPeriod, 10));
  const multiplier = finite(input.multiplier, 3);
  if (!(fixedVolume > 0)) throw new Error("fixedVolume must be positive.");
  if (atrPeriod < 2 || atrPeriod > 100) throw new Error("atrPeriod must be between 2 and 100.");
  if (!(multiplier > 0) || multiplier > 20) throw new Error("multiplier must be > 0 and <= 20.");

  const fromMs = Date.parse(input.from);
  const toStartMs = Date.parse(input.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toStartMs)) throw new Error("Invalid from/to date.");
  const toMs = toStartMs + DAY_MS;
  if (fromMs >= toMs) throw new Error("from must be before to.");
  const days = Math.ceil((toMs - fromMs) / DAY_MS);
  if (days > MAX_RESEARCH_DAYS) throw new Error(`Phase 7E realignment supports up to ${MAX_RESEARCH_DAYS} days.`);

  const warmupFromMs = fromMs - 45 * DAY_MS;
  const [health, spec, m15, m5, baseline] = await Promise.all([
    bridgeGet<BridgeHealth>("/health", 20_000),
    bridgeGet<Spec>("/v1/symbols/XAUUSD/spec", 20_000),
    bridgeGet<Bar[]>(`/v1/history/candles/XAUUSD?timeframe=M15&fromMs=${warmupFromMs}&toMs=${toMs}`, 60_000),
    bridgeGet<Bar[]>(`/v1/history/candles/XAUUSD?timeframe=M5&fromMs=${warmupFromMs}&toMs=${toMs}`, 90_000),
    runPhase7CCanonicalBacktest({ from: input.from, to: input.to, fixedVolume }),
  ]);
  if (!health.connected || health.accountMode !== "demo") throw new Error("Phase 7E realignment requires a connected DEMO terminal.");
  validateFixedVolume(fixedVolume, spec);

  const sortedM15 = [...m15].sort((a, b) => a.openTime - b.openTime);
  const sortedM5 = [...m5].sort((a, b) => a.openTime - b.openTime);
  if (sortedM15.length <= M15_MIN_HISTORY) throw new Error(`Insufficient M15 history (${sortedM15.length} bars).`);
  if (!sortedM5.length) throw new Error("No M5 history returned for selected range.");

  const m5CloseTimes = sortedM5.map((b) => b.closeTime);
  const m5OpenTimes = sortedM5.map((b) => b.openTime);
  const m15CloseTimes = sortedM15.map((b) => b.closeTime);
  const ma20 = rollingSma(sortedM15.map((b) => b.close), 20);
  const st15 = supertrend(sortedM15, atrPeriod, multiplier);
  const st5 = supertrend(sortedM5, atrPeriod, multiplier);
  const swingLows = buildConfirmedSwings(sortedM15, "BUY");
  const swingHighs = buildConfirmedSwings(sortedM15, "SELL");

  let patternSignals = 0;
  let m15Aligned = 0;
  let dualStateAligned = 0;
  let timeframeDisagreement = 0;
  const dualSignals: Signal[] = [];

  for (let index = M15_MIN_HISTORY; index < sortedM15.length; index += 1) {
    const current = sortedM15[index]!;
    if (current.closeTime < fromMs || current.closeTime >= toMs) continue;
    const trigger = detectPattern(sortedM15, index);
    if (!trigger) continue;
    patternSignals += 1;
    const wanted = sideDirection(trigger.side);
    const d15 = st15[index];
    if (d15 === wanted) m15Aligned += 1;
    const m5Index = upperBound(m5CloseTimes, current.closeTime) - 1;
    const d5 = m5Index >= 0 ? st5[m5Index] : null;
    if (d15 !== null && d5 !== null && d15 !== d5) timeframeDisagreement += 1;
    if (d15 !== wanted || d5 !== wanted || m5Index < 1) continue;
    dualStateAligned += 1;
    const flipAge = freshFlipAge(st5, m5Index, wanted);
    const structural = trigger.side === "BUY" ? current.close - trigger.patternExtreme : trigger.patternExtreme - current.close;
    if (!(structural > 0)) continue;
    dualSignals.push({
      side: trigger.side,
      pattern: trigger.pattern,
      signalTimestamp: current.closeTime,
      patternExtreme: trigger.patternExtreme,
      stopDistance: clamp(structural, MIN_STOP, MAX_STOP),
      m15Direction: d15,
      m5Direction: d5,
      m5FlipAgeBars: flipAge,
    });
  }

  const variantDefinitions: Array<{ name: VariantName; maxFlipAge: number | null }> = [
    { name: "DUAL_STATE", maxFlipAge: null },
    { name: "M5_FLIP_1", maxFlipAge: 0 },
    { name: "M5_FLIP_2", maxFlipAge: 1 },
    { name: "M5_FLIP_3", maxFlipAge: 2 },
  ];

  const variants = variantDefinitions.map((definition) => {
    const accepted = definition.maxFlipAge === null
      ? dualSignals
      : dualSignals.filter((signal) => signal.m5FlipAgeBars !== null && signal.m5FlipAgeBars <= definition.maxFlipAge!);
    const raw = accepted
      .map((signal) => simulateTrade(signal, sortedM15, sortedM5, m5OpenTimes, m15CloseTimes, ma20, spec, fixedVolume, swingLows, swingHighs))
      .filter((trade): trade is Trade => trade !== null)
      .sort((a, b) => a.signalTimestamp - b.signalTimestamp);
    const scheduled = schedule(raw);
    const metrics = summarize(scheduled.trades, scheduled.skippedWhileOpen);
    return {
      name: definition.name,
      maxFlipAgeBars: definition.maxFlipAge,
      acceptedSignals: accepted.length,
      metrics,
      buy: summarize(scheduled.trades.filter((trade) => trade.side === "BUY"), 0),
      sell: summarize(scheduled.trades.filter((trade) => trade.side === "SELL"), 0),
      engulfing: summarize(scheduled.trades.filter((trade) => trade.pattern === "ENGULFING"), 0),
      twoCandle: summarize(scheduled.trades.filter((trade) => trade.pattern === "TWO_CANDLE_BODY_DOMINANCE"), 0),
      trades: scheduled.trades.slice(-500).reverse(),
    };
  });

  const state = variants[0]!;
  const flipVariants = variants.slice(1);
  const baselineMetrics = baseline.metrics;
  const ranked = [...flipVariants].sort((a, b) => rankScore(b.metrics, baselineMetrics.maxDrawdownUsd) - rankScore(a.metrics, baselineMetrics.maxDrawdownUsd));
  const best = ranked[0]!;
  const sufficientSample = best.metrics.trades >= 100 && baselineMetrics.trades >= 100;
  const viable = sufficientSample && best.metrics.netPnl > 0 && (best.metrics.profitFactor ?? 0) > 1 && best.metrics.expectancy > 0 && best.metrics.maxDrawdownUsd <= baselineMetrics.maxDrawdownUsd * 1.25 + 1e-9;
  const improvesState = best.metrics.netPnl > state.metrics.netPnl && (best.metrics.profitFactor ?? 0) > (state.metrics.profitFactor ?? 0) && best.metrics.expectancy > state.metrics.expectancy;

  return {
    source: "PHASE7E_M15_SUPERTREND_M5_REALIGNMENT_RESEARCH",
    replayMode: "CLOSED_M15_PATTERN_PLUS_M15_SUPERTREND_AND_FRESH_CLOSED_M5_FLIP_WITH_M5_EXECUTION_APPROXIMATION",
    generatedAt: Date.now(),
    safety: { researchOnly: true, executionMutation: false, phase7bStrategyMutation: false, liveUnlockAvailable: false, profitGuarantee: false },
    configuration: {
      from: input.from,
      to: input.to,
      days,
      fixedVolume,
      atrPeriod,
      multiplier,
      maEntryFilter: "REMOVED_IN_RESEARCH_LANES",
      m15Rule: "PATTERN_DIRECTION_EQUALS_CLOSED_M15_SUPERTREND",
      m5Rule: "CURRENT_DIRECTION_ALIGNED_AND_OPPOSITE_TO_ALIGNED_FLIP_WITHIN_N_CLOSED_M5_BARS",
      freshFlipWindows: [1, 2, 3],
      management: "UNCHANGED_CANONICAL_PLUS6_BE_PLUS10_ONE_THIRD_STRUCTURE_FVG_MA20_EXIT",
      accountLogin: health.accountLogin,
      server: health.server,
      symbol: spec.brokerSymbol,
    },
    signalDiagnostics: {
      patternSignals,
      m15Aligned,
      dualStateAligned,
      timeframeDisagreement,
      dualSignals: dualSignals.length,
      flip1Signals: variants[1]!.acceptedSignals,
      flip2Signals: variants[2]!.acceptedSignals,
      flip3Signals: variants[3]!.acceptedSignals,
    },
    maBaseline: {
      metrics: {
        trades: baselineMetrics.trades,
        skippedWhileOpen: baselineMetrics.skippedWhilePositionOpen,
        winRatePercent: baselineMetrics.winRatePercent,
        netPnl: baselineMetrics.netPnl,
        profitFactor: baselineMetrics.profitFactor,
        expectancy: baselineMetrics.expectancy,
        averageR: baselineMetrics.averageR,
        maxDrawdownUsd: baselineMetrics.maxDrawdownUsd,
        averageHoldHours: baselineMetrics.averageHoldHours,
      },
    },
    variants,
    decision: {
      sufficientSample,
      preferredResearchLane: best.name,
      verdict: viable ? "REALIGNMENT_RESEARCH_PROMISING" : improvesState ? "REALIGNMENT_IMPROVES_STATE_BUT_NOT_VIABLE" : "KEEP_MA_BASELINE_RESEARCH",
      executionEligible: false,
      reason: viable
        ? `${best.name} has positive Net/PF/expectancy with drawdown inside the research guard.`
        : improvesState
          ? `${best.name} improves the raw Dual-Supertrend state lane but does not yet pass positive-economics and drawdown guards versus MA baseline.`
          : "Fresh M5 flip filtering does not materially improve the Dual-Supertrend state lane enough to justify promotion.",
    },
    notes: [
      "Candle entry models are unchanged: tolerance-aware Engulfing and corrected Two-candle body dominance.",
      "MA20/50/200 are absent from the entry gate. MA20 remains only as the unchanged canonical exit fallback for clean A/B isolation.",
      "M15 Supertrend must already match the pattern side. M5 must match the same side and have flipped from the opposite Supertrend state recently.",
      "M5_FLIP_1 means the latest closed M5 bar itself is the opposite-to-aligned flip; FLIP_2 allows that flip in the current or prior closed M5 bar; FLIP_3 allows current/prior two closed M5 bars.",
      "Each lane performs its own max-one-position contention replay; filtering a trade can reopen later signals in that lane.",
      "ATR 10 / multiplier 3.0 is the default. Parameter optimization is intentionally deferred until the fresh-flip hypothesis is evaluated.",
      "Research only. Phase 7B DEMO execution is unchanged.",
    ],
  };
}

function rankScore(metrics: Metrics, baselineDd: number) {
  const pf = metrics.profitFactor ?? 0;
  const ddPenalty = baselineDd > 0 ? metrics.maxDrawdownUsd / baselineDd : 1;
  return metrics.netPnl + metrics.expectancy * 50 + (pf - 1) * 300 - Math.max(0, ddPenalty - 1) * 200 + Math.min(metrics.trades, 100) * 0.05;
}

function freshFlipAge(direction: Array<Direction | null>, index: number, wanted: Direction): number | null {
  for (let cursor = index; cursor >= 1; cursor -= 1) {
    if (direction[cursor] === wanted && direction[cursor - 1] === -wanted) return index - cursor;
    if (index - cursor > 100) break;
  }
  return null;
}

function schedule(rawTrades: Trade[]) {
  const trades: Trade[] = [];
  let busyUntil = -Infinity;
  let skippedWhileOpen = 0;
  for (const trade of rawTrades) {
    if (trade.signalTimestamp < busyUntil) { skippedWhileOpen += 1; continue; }
    trades.push(trade);
    busyUntil = trade.exitTime;
  }
  return { trades, skippedWhileOpen };
}

function simulateTrade(signal: Signal, m15: Bar[], m5: Bar[], m5OpenTimes: number[], m15CloseTimes: number[], ma20: Array<number | null>, spec: Spec, volume: number, swingLows: Array<{ confirmedAt: number; level: number }>, swingHighs: Array<{ confirmedAt: number; level: number }>): Trade | null {
  const startIndex = lowerBound(m5OpenTimes, signal.signalTimestamp);
  const first = m5[startIndex];
  if (!first || first.openTime > signal.signalTimestamp + ENTRY_EXPIRY_MS) return null;
  const entry = signal.side === "BUY" ? first.open + first.spread : first.open;
  const stopLoss = signal.side === "BUY" ? entry - signal.stopDistance : entry + signal.stopDistance;
  const initialRiskUsd = signal.stopDistance * cashPerPrice(spec) * volume;
  let activeStop = stopLoss;
  let remainingVolume = volume;
  let breakEvenApplied = false;
  let partialApplied = false;
  let partialVolume = 0;
  let partialPnl = 0;
  let structuralTrailUpdates = 0;
  let lastReversalM15CloseChecked = signal.signalTimestamp;
  const trendExit = findTrendExit(signal, m15, m15CloseTimes, ma20);

  for (let index = startIndex; index < m5.length; index += 1) {
    const bar = m5[index]!;
    if (stopTouched(signal.side, bar, activeStop)) return closeTrade(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, bar.closeTime, activeStop, remainingVolume, breakEvenApplied, partialApplied, partialVolume, partialPnl, structuralTrailUpdates, "STOP", spec);
    const favorable = favorableMove(signal.side, entry, bar);
    if (!breakEvenApplied && favorable >= BREAK_EVEN_TRIGGER) { activeStop = improveStop(signal.side, activeStop, entry); breakEvenApplied = true; }
    if (!partialApplied && favorable >= PARTIAL_TRIGGER) {
      const closeVolume = executablePartialVolume(volume, 1 / 3, spec);
      if (closeVolume > 0 && remainingVolume - closeVolume >= spec.minVolume - 1e-9) {
        const triggerPrice = signal.side === "BUY" ? entry + PARTIAL_TRIGGER : entry - PARTIAL_TRIGGER;
        partialApplied = true;
        partialVolume = closeVolume;
        partialPnl = pnlUsd(signal.side, entry, triggerPrice, closeVolume, spec);
        remainingVolume = normalizeVolume(remainingVolume - closeVolume, spec.volumeStep);
      }
    }
    if (partialApplied) {
      const structure = latestConfirmedStructure(signal.side, signal.signalTimestamp, bar.closeTime, swingLows, swingHighs);
      if (structure !== null) {
        const improved = improveStop(signal.side, activeStop, structure);
        if (Math.abs(improved - activeStop) > 1e-9) structuralTrailUpdates += 1;
        activeStop = improved;
      }
      const currentM15Index = upperBound(m15CloseTimes, bar.closeTime) - 1;
      if (currentM15Index >= 2) {
        const currentM15 = m15[currentM15Index]!;
        if (currentM15.closeTime > lastReversalM15CloseChecked && currentM15.closeTime > signal.signalTimestamp) {
          lastReversalM15CloseChecked = currentM15.closeTime;
          if (opposingFvgRejectionAt(signal.side, m15, currentM15Index, REVERSAL_FVG_LOOKBACK)) {
            const exit = closePriceForSide(signal.side, currentM15.close, currentM15.spread);
            return closeTrade(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, currentM15.closeTime, exit, remainingVolume, breakEvenApplied, partialApplied, partialVolume, partialPnl, structuralTrailUpdates, "REVERSAL_FVG_REJECTION", spec);
          }
        }
      }
    }
    if (trendExit !== null && bar.closeTime >= trendExit.timestamp) return closeTrade(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, trendExit.timestamp, trendExit.price, remainingVolume, breakEvenApplied, partialApplied, partialVolume, partialPnl, structuralTrailUpdates, "TREND_MA20", spec);
  }
  const last = m5.at(-1)!;
  const exit = closePriceForSide(signal.side, last.close, last.spread);
  return closeTrade(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, last.closeTime, exit, remainingVolume, breakEvenApplied, partialApplied, partialVolume, partialPnl, structuralTrailUpdates, "END_OF_DATA", spec);
}

function closeTrade(signal: Signal, entryTime: number, entry: number, stopLoss: number, initialRiskUsd: number, volume: number, exitTime: number, exit: number, remainingVolume: number, breakEvenApplied: boolean, partialApplied: boolean, partialVolume: number, partialPnl: number, structuralTrailUpdates: number, exitReason: ExitReason, spec: Spec): Trade {
  const remainingPnl = pnlUsd(signal.side, entry, exit, remainingVolume, spec);
  const pnl = partialPnl + remainingPnl;
  return { ...signal, entryTime, entry: round(entry, spec.digits), stopLoss: round(stopLoss, spec.digits), initialRiskUsd: round(initialRiskUsd, 2), volume: round(volume, 4), exitTime, exit: round(exit, spec.digits), pnl: round(pnl, 2), rMultiple: round(initialRiskUsd > 0 ? pnl / initialRiskUsd : 0, 4), holdHours: round((exitTime - entryTime) / 3_600_000, 4), breakEvenApplied, partialApplied, partialVolume: round(partialVolume, 4), partialPnl: round(partialPnl, 2), remainingVolumeAtExit: round(remainingVolume, 4), structuralTrailUpdates, exitReason };
}

function summarize(trades: Trade[], skippedWhileOpen: number) {
  const grossProfit = trades.reduce((sum, trade) => sum + Math.max(0, trade.pnl), 0);
  const grossLoss = Math.abs(trades.reduce((sum, trade) => sum + Math.min(0, trade.pnl), 0));
  const netPnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const wins = trades.filter((trade) => trade.pnl > 0).length;
  let equity = 0, peak = 0, maxDrawdownUsd = 0;
  for (const trade of [...trades].sort((a, b) => a.exitTime - b.exitTime)) { equity += trade.pnl; peak = Math.max(peak, equity); maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - equity); }
  return { trades: trades.length, skippedWhileOpen, winRatePercent: round(trades.length ? wins / trades.length * 100 : 0, 2), netPnl: round(netPnl, 2), profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : grossProfit > 0 ? null : 0, expectancy: round(trades.length ? netPnl / trades.length : 0, 4), averageR: round(avg(trades.map((trade) => trade.rMultiple)), 4), maxDrawdownUsd: round(maxDrawdownUsd, 2), averageHoldHours: round(avg(trades.map((trade) => trade.holdHours)), 4) };
}

function supertrend(bars: Bar[], period: number, multiplier: number): Array<Direction | null> {
  const tr = bars.map((bar, index) => index === 0 ? bar.high - bar.low : Math.max(bar.high - bar.low, Math.abs(bar.high - bars[index - 1]!.close), Math.abs(bar.low - bars[index - 1]!.close)));
  const atr: Array<number | null> = Array(bars.length).fill(null);
  if (bars.length >= period) {
    let sum = 0; for (let i = 0; i < period; i += 1) sum += tr[i]!; atr[period - 1] = sum / period;
    for (let i = period; i < bars.length; i += 1) atr[i] = (atr[i - 1]! * (period - 1) + tr[i]!) / period;
  }
  const upper: Array<number | null> = Array(bars.length).fill(null), lower: Array<number | null> = Array(bars.length).fill(null), direction: Array<Direction | null> = Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i += 1) {
    const bar = bars[i]!, a = atr[i]; if (a === null) continue;
    const hl2 = (bar.high + bar.low) / 2, basicUpper = hl2 + multiplier * a, basicLower = hl2 - multiplier * a;
    if (i === period - 1 || upper[i - 1] === null || lower[i - 1] === null || direction[i - 1] === null) { upper[i] = basicUpper; lower[i] = basicLower; direction[i] = bar.close >= hl2 ? 1 : -1; continue; }
    const previous = bars[i - 1]!, prevUpper = upper[i - 1]!, prevLower = lower[i - 1]!;
    upper[i] = basicUpper < prevUpper || previous.close > prevUpper ? basicUpper : prevUpper;
    lower[i] = basicLower > prevLower || previous.close < prevLower ? basicLower : prevLower;
    direction[i] = direction[i - 1] === 1 ? (bar.close < lower[i]! ? -1 : 1) : (bar.close > upper[i]! ? 1 : -1);
  }
  return direction;
}

function detectPattern(bars: Bar[], index: number): { side: Side; pattern: Pattern; patternExtreme: number } | null {
  const current = bars[index]!, previous = bars[index - 1]!;
  if (isBearish(previous) && isBullish(current) && current.open <= previous.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 && current.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.open) return { side: "BUY", pattern: "ENGULFING", patternExtreme: current.low };
  if (isBullish(previous) && isBearish(current) && current.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.close && current.close <= previous.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9) return { side: "SELL", pattern: "ENGULFING", patternExtreme: current.high };
  if (index < 2) return null;
  const prior = bars[index - 2]!, first = bars[index - 1]!, priorBody = bodySize(prior), firstBody = bodySize(first), combined = firstBody + bodySize(current);
  if (isBearish(prior) && isBullish(first) && isBullish(current) && firstBody < priorBody && combined > priorBody) return { side: "BUY", pattern: "TWO_CANDLE_BODY_DOMINANCE", patternExtreme: Math.min(prior.low, first.low, current.low) };
  if (isBullish(prior) && isBearish(first) && isBearish(current) && firstBody < priorBody && combined > priorBody) return { side: "SELL", pattern: "TWO_CANDLE_BODY_DOMINANCE", patternExtreme: Math.max(prior.high, first.high, current.high) };
  return null;
}

function findTrendExit(signal: Signal, m15: Bar[], closeTimes: number[], ma20: Array<number | null>) {
  const start = lowerBound(closeTimes, signal.signalTimestamp);
  for (let index = start + 1; index < m15.length; index += 1) { const bar = m15[index]!, average = ma20[index]; if (!Number.isFinite(average)) continue; const broken = signal.side === "BUY" ? bar.close < average! : bar.close > average!; if (broken) return { timestamp: bar.closeTime, price: closePriceForSide(signal.side, bar.close, bar.spread) }; }
  return null;
}

function opposingFvgRejectionAt(side: Side, bars: Bar[], currentIndex: number, lookback: number) {
  const current = bars[currentIndex]!; if (!(side === "BUY" ? isBearish(current) : isBullish(current))) return false;
  const start = Math.max(2, currentIndex - lookback);
  for (let index = currentIndex - 1; index >= start; index -= 1) {
    const first = bars[index - 2]!, third = bars[index]!;
    if (side === "BUY" && third.high < first.low) { const zoneLow = third.high, zoneHigh = first.low; if (current.high >= zoneLow && current.low <= zoneHigh && current.close < zoneHigh) return true; }
    if (side === "SELL" && third.low > first.high) { const zoneLow = first.high, zoneHigh = third.low; if (current.high >= zoneLow && current.low <= zoneHigh && current.close > zoneLow) return true; }
  }
  return false;
}

function buildConfirmedSwings(bars: Bar[], side: Side) { const result: Array<{ confirmedAt: number; level: number }> = []; for (let index = 1; index < bars.length - 1; index += 1) { const left = bars[index - 1]!, middle = bars[index]!, right = bars[index + 1]!; if (side === "BUY" && middle.low < left.low && middle.low <= right.low) result.push({ confirmedAt: right.closeTime, level: middle.low }); if (side === "SELL" && middle.high > left.high && middle.high >= right.high) result.push({ confirmedAt: right.closeTime, level: middle.high }); } return result; }
function latestConfirmedStructure(side: Side, after: number, atOrBefore: number, lows: Array<{ confirmedAt: number; level: number }>, highs: Array<{ confirmedAt: number; level: number }>) { const swings = side === "BUY" ? lows : highs; const index = upperBound(swings.map((item) => item.confirmedAt), atOrBefore) - 1; if (index < 0) return null; const item = swings[index]!; return item.confirmedAt > after ? item.level : null; }
function sideDirection(side: Side): Direction { return side === "BUY" ? 1 : -1; }
function favorableMove(side: Side, entry: number, bar: Bar) { return side === "BUY" ? bar.high - entry : entry - (bar.low + bar.spread); }
function stopTouched(side: Side, bar: Bar, stop: number) { return side === "BUY" ? bar.low <= stop + 1e-9 : bar.high + bar.spread >= stop - 1e-9; }
function closePriceForSide(side: Side, bid: number, spread: number) { return side === "BUY" ? bid : bid + spread; }
function improveStop(side: Side, current: number, candidate: number) { return side === "BUY" ? Math.max(current, candidate) : Math.min(current, candidate); }
function pnlUsd(side: Side, entry: number, exit: number, volume: number, spec: Spec) { return (side === "BUY" ? exit - entry : entry - exit) * cashPerPrice(spec) * volume; }
function cashPerPrice(spec: Spec) { return spec.cashPerPriceUnitPerLot > 0 ? spec.cashPerPriceUnitPerLot : spec.tickSize > 0 ? spec.effectiveTickValuePerLot / spec.tickSize : 0; }
function executablePartialVolume(initial: number, fraction: number, spec: Spec) { const raw = initial * fraction, stepped = Math.round(raw / spec.volumeStep) * spec.volumeStep; if (Math.abs(stepped - raw) > spec.volumeStep / 100 || stepped < spec.minVolume - 1e-9 || initial - stepped < spec.minVolume - 1e-9) return 0; return stepped; }
function validateFixedVolume(volume: number, spec: Spec) { if (volume < spec.minVolume - 1e-9 || volume > spec.maxVolume + 1e-9) throw new Error(`fixedVolume ${volume} outside broker range.`); const stepped = Math.round(volume / spec.volumeStep) * spec.volumeStep; if (Math.abs(stepped - volume) > spec.volumeStep / 100) throw new Error(`fixedVolume ${volume} is not aligned to volumeStep ${spec.volumeStep}.`); }
function rollingSma(values: number[], period: number) { const output: Array<number | null> = Array(values.length).fill(null); let sum = 0; for (let i = 0; i < values.length; i += 1) { sum += values[i]!; if (i >= period) sum -= values[i - period]!; if (i >= period - 1) output[i] = sum / period; } return output; }
function lowerBound(values: number[], target: number) { let low = 0, high = values.length; while (low < high) { const mid = (low + high) >>> 1; if (values[mid]! < target) low = mid + 1; else high = mid; } return low; }
function upperBound(values: number[], target: number) { let low = 0, high = values.length; while (low < high) { const mid = (low + high) >>> 1; if (values[mid]! <= target) low = mid + 1; else high = mid; } return low; }
function normalizeVolume(value: number, step: number) { return round(Math.max(0, Math.round(value / step) * step), 8); }
function isBullish(bar: Bar) { return bar.close > bar.open; }
function isBearish(bar: Bar) { return bar.close < bar.open; }
function bodySize(bar: Bar) { return Math.abs(bar.close - bar.open); }
function finite(value: number | undefined, fallback: number) { return Number.isFinite(value) ? Number(value) : fallback; }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
function avg(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function round(value: number, digits: number) { const factor = 10 ** digits; return Math.round((value + Number.EPSILON) * factor) / factor; }
