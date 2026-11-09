import { runPhase7CCanonicalBacktest } from "./phase7c.service";

export type Phase7ESupertrendRequest = { from: string; to: string; fixedVolume?: number; atrPeriod?: number; multiplier?: number };
type Side = "BUY" | "SELL";
type Pattern = "ENGULFING" | "TWO_CANDLE_BODY_DOMINANCE";
type Direction = 1 | -1;
type ExitReason = "STOP" | "TREND_MA20" | "REVERSAL_FVG_REJECTION" | "END_OF_DATA";
type Bar = { openTime: number; closeTime: number; open: number; high: number; low: number; close: number; spread: number };
type BridgeHealth = { connected: boolean; accountMode: "demo" | "contest" | "real" | null; accountLogin: number | null; server: string | null };
type Spec = { brokerSymbol: string; tickSize: number; effectiveTickValuePerLot: number; cashPerPriceUnitPerLot: number; digits: number; minVolume: number; maxVolume: number; volumeStep: number };
type Signal = { side: Side; pattern: Pattern; signalTimestamp: number; patternExtreme: number; stopDistance: number; m15Direction: Direction; m5Direction: Direction };
type Trade = Signal & { entryTime: number; entry: number; stopLoss: number; initialRiskUsd: number; volume: number; exitTime: number; exit: number; pnl: number; rMultiple: number; holdHours: number; breakEvenApplied: boolean; partialApplied: boolean; partialVolume: number; partialPnl: number; remainingVolumeAtExit: number; structuralTrailUpdates: number; exitReason: ExitReason };

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
function bridgeApiKey() { const value = process.env.MT5_BRIDGE_API_KEY?.trim() ?? ""; if (!value) throw new Error("MT5_BRIDGE_API_KEY is not configured for Phase 7E research."); return value; }
async function bridgeGet<T>(path: string, timeoutMs = 60_000): Promise<T> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try { const response = await fetch(`${bridgeBase()}${path}`, { headers: { "x-mt5-api-key": bridgeApiKey() }, signal: controller.signal, cache: "no-store" }); const text = await response.text(); if (!response.ok) throw new Error(`MT5 bridge ${response.status}: ${text}`); return JSON.parse(text) as T; }
  finally { clearTimeout(timeout); }
}

export async function runPhase7ESupertrendResearch(input: Phase7ESupertrendRequest) {
  const fixedVolume = finite(input.fixedVolume, 0.03);
  const atrPeriod = Math.trunc(finite(input.atrPeriod, 10));
  const multiplier = finite(input.multiplier, 3);
  if (!(fixedVolume > 0)) throw new Error("fixedVolume must be positive.");
  if (atrPeriod < 2 || atrPeriod > 100) throw new Error("atrPeriod must be between 2 and 100.");
  if (!(multiplier > 0) || multiplier > 20) throw new Error("multiplier must be > 0 and <= 20.");

  const fromMs = Date.parse(input.from), toStartMs = Date.parse(input.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toStartMs)) throw new Error("Invalid from/to date.");
  const toMs = toStartMs + DAY_MS;
  if (fromMs >= toMs) throw new Error("from must be before to.");
  const days = Math.ceil((toMs - fromMs) / DAY_MS);
  if (days > MAX_RESEARCH_DAYS) throw new Error(`Phase 7E research supports up to ${MAX_RESEARCH_DAYS} days.`);

  const warmupFromMs = fromMs - 45 * DAY_MS;
  const [health, spec, m15, m5, baseline] = await Promise.all([
    bridgeGet<BridgeHealth>("/health", 20_000),
    bridgeGet<Spec>("/v1/symbols/XAUUSD/spec", 20_000),
    bridgeGet<Bar[]>(`/v1/history/candles/XAUUSD?timeframe=M15&fromMs=${warmupFromMs}&toMs=${toMs}`, 60_000),
    bridgeGet<Bar[]>(`/v1/history/candles/XAUUSD?timeframe=M5&fromMs=${warmupFromMs}&toMs=${toMs}`, 90_000),
    runPhase7CCanonicalBacktest({ from: input.from, to: input.to, fixedVolume }),
  ]);
  if (!health.connected || health.accountMode !== "demo") throw new Error("Phase 7E research requires a connected DEMO terminal.");
  validateFixedVolume(fixedVolume, spec);

  const sortedM15 = [...m15].sort((a, b) => a.openTime - b.openTime);
  const sortedM5 = [...m5].sort((a, b) => a.openTime - b.openTime);
  if (sortedM15.length <= M15_MIN_HISTORY) throw new Error(`Insufficient M15 history (${sortedM15.length} bars).`);
  if (!sortedM5.length) throw new Error("No M5 history returned for selected range.");

  const m5CloseTimes = sortedM5.map((b) => b.closeTime), m5OpenTimes = sortedM5.map((b) => b.openTime), m15CloseTimes = sortedM15.map((b) => b.closeTime);
  const ma20 = rollingSma(sortedM15.map((b) => b.close), 20);
  const st15 = supertrend(sortedM15, atrPeriod, multiplier), st5 = supertrend(sortedM5, atrPeriod, multiplier);
  const swingLows = buildConfirmedSwings(sortedM15, "BUY"), swingHighs = buildConfirmedSwings(sortedM15, "SELL");

  let patternSignals = 0, m15Aligned = 0, m5Aligned = 0, dualAligned = 0, timeframeDisagreement = 0, buySignals = 0, sellSignals = 0;
  const signals: Signal[] = [];
  for (let index = M15_MIN_HISTORY; index < sortedM15.length; index += 1) {
    const current = sortedM15[index]!;
    if (current.closeTime < fromMs || current.closeTime >= toMs) continue;
    const trigger = detectPattern(sortedM15, index); if (!trigger) continue;
    patternSignals += 1;
    const d15 = st15[index]; const m5Index = upperBound(m5CloseTimes, current.closeTime) - 1; const d5 = m5Index >= 0 ? st5[m5Index] : null;
    const wanted = sideDirection(trigger.side);
    if (d15 === wanted) m15Aligned += 1; if (d5 === wanted) m5Aligned += 1; if (d15 !== null && d5 !== null && d15 !== d5) timeframeDisagreement += 1;
    if (d15 !== wanted || d5 !== wanted) continue;
    dualAligned += 1;
    const structural = trigger.side === "BUY" ? current.close - trigger.patternExtreme : trigger.patternExtreme - current.close;
    if (!(structural > 0)) continue;
    signals.push({ side: trigger.side, pattern: trigger.pattern, signalTimestamp: current.closeTime, patternExtreme: trigger.patternExtreme, stopDistance: clamp(structural, MIN_STOP, MAX_STOP), m15Direction: d15, m5Direction: d5 });
    if (trigger.side === "BUY") buySignals += 1; else sellSignals += 1;
  }

  const rawTrades = signals.map((s) => simulateTrade(s, sortedM15, sortedM5, m5OpenTimes, m15CloseTimes, ma20, spec, fixedVolume, swingLows, swingHighs)).filter((t): t is Trade => t !== null).sort((a, b) => a.signalTimestamp - b.signalTimestamp);
  const trades: Trade[] = []; let busyUntil = -Infinity, skippedWhileOpen = 0;
  for (const trade of rawTrades) { if (trade.signalTimestamp < busyUntil) { skippedWhileOpen += 1; continue; } trades.push(trade); busyUntil = trade.exitTime; }

  const metrics = summarize(trades, skippedWhileOpen);
  const buy = summarize(trades.filter((t) => t.side === "BUY"), 0), sell = summarize(trades.filter((t) => t.side === "SELL"), 0);
  const engulfing = summarize(trades.filter((t) => t.pattern === "ENGULFING"), 0), twoCandle = summarize(trades.filter((t) => t.pattern === "TWO_CANDLE_BODY_DOMINANCE"), 0);
  const baselineMetrics = baseline.metrics;
  const comparison = {
    tradesDelta: metrics.trades - baselineMetrics.trades,
    winRateDeltaPp: round(metrics.winRatePercent - baselineMetrics.winRatePercent, 2),
    netPnlDelta: round(metrics.netPnl - baselineMetrics.netPnl, 2),
    profitFactorDelta: metrics.profitFactor !== null && baselineMetrics.profitFactor !== null ? round(metrics.profitFactor - baselineMetrics.profitFactor, 4) : null,
    expectancyDelta: round(metrics.expectancy - baselineMetrics.expectancy, 4),
    maxDrawdownDelta: round(metrics.maxDrawdownUsd - baselineMetrics.maxDrawdownUsd, 2),
  };
  const sufficientSample = metrics.trades >= 100 && baselineMetrics.trades >= 100;
  const betterEconomics = metrics.netPnl > baselineMetrics.netPnl && (metrics.profitFactor ?? 999) >= (baselineMetrics.profitFactor ?? 0) && metrics.expectancy > baselineMetrics.expectancy && metrics.maxDrawdownUsd <= baselineMetrics.maxDrawdownUsd * 1.25 + 1e-9;

  return {
    source: "PHASE7E_PATTERN_DUAL_SUPERTREND_RESEARCH",
    replayMode: "CLOSED_M15_PATTERN_PLUS_CLOSED_M5_M15_SUPERTREND_WITH_M5_EXECUTION_APPROXIMATION",
    generatedAt: Date.now(),
    safety: { researchOnly: true, executionMutation: false, phase7bStrategyMutation: false, liveUnlockAvailable: false, profitGuarantee: false },
    configuration: { from: input.from, to: input.to, days, fixedVolume, atrPeriod, multiplier, entryRule: "PATTERN_PLUS_SUPERTREND_M5_M15_SAME_DIRECTION", maEntryFilter: "REMOVED_IN_RESEARCH_LANE", m15SupertrendSource: "CLOSED_M15_BAR", m5SupertrendSource: "LAST_CLOSED_M5_AT_OR_BEFORE_M15_SIGNAL_CLOSE", management: "UNCHANGED_CANONICAL_PLUS6_BE_PLUS10_ONE_THIRD_STRUCTURE_FVG_MA20_EXIT", accountLogin: health.accountLogin, server: health.server, symbol: spec.brokerSymbol },
    signalDiagnostics: { patternSignals, m15Aligned, m5Aligned, dualAligned, timeframeDisagreement, acceptedSignals: signals.length, buySignals, sellSignals },
    baseline: { source: baseline.source, entryRule: "PATTERN_PLUS_MA20_50_200", metrics: { trades: baselineMetrics.trades, skippedWhileOpen: baselineMetrics.skippedWhilePositionOpen, winRatePercent: baselineMetrics.winRatePercent, netPnl: baselineMetrics.netPnl, profitFactor: baselineMetrics.profitFactor, expectancy: baselineMetrics.expectancy, averageR: baselineMetrics.averageR, maxDrawdownUsd: baselineMetrics.maxDrawdownUsd, averageHoldHours: baselineMetrics.averageHoldHours } },
    supertrend: { metrics, buy, sell, engulfing, twoCandle, trades: trades.slice(-500).reverse() },
    comparison,
    decision: { sufficientSample, verdict: !sufficientSample ? "INSUFFICIENT_SAMPLE" : betterEconomics ? "DUAL_SUPERTREND_RESEARCH_PROMISING" : metrics.netPnl > baselineMetrics.netPnl ? "DUAL_SUPERTREND_MIXED" : "KEEP_MA_BASELINE_RESEARCH", executionEligible: false, reason: !sufficientSample ? "Need at least 100 scheduled trades in both MA baseline and dual-Supertrend lane." : betterEconomics ? "Dual Supertrend improves net/PF/expectancy without increasing max drawdown by more than 25% in this sample." : "Dual Supertrend does not pass all economics and drawdown guards versus the MA baseline in this sample." },
    notes: [
      "The two candle models are unchanged: tolerance-aware Engulfing or corrected two-candle body dominance.",
      "MA20/50/200 are removed only from the Phase 7E ENTRY gate.",
      "BUY requires a BUY pattern plus closed M15 Supertrend BUY and last-closed M5 Supertrend BUY; SELL is symmetric.",
      "If M5 and M15 Supertrend disagree, the signal is rejected.",
      "Canonical management is intentionally unchanged so this A/B isolates the entry filter; MA20 remains only as the existing exit fallback in this first research pass.",
      "Supertrend uses Wilder ATR. Default ATR period 10 and multiplier 3.0.",
      "Closed bars only; no forming-bar Supertrend state is used.",
      "Research only. Phase 7B DEMO execution remains unchanged.",
    ],
  };
}

function simulateTrade(signal: Signal, m15: Bar[], m5: Bar[], m5OpenTimes: number[], m15CloseTimes: number[], ma20: Array<number | null>, spec: Spec, volume: number, swingLows: Array<{ confirmedAt: number; level: number }>, swingHighs: Array<{ confirmedAt: number; level: number }>): Trade | null {
  const startIndex = lowerBound(m5OpenTimes, signal.signalTimestamp), first = m5[startIndex]; if (!first || first.openTime > signal.signalTimestamp + ENTRY_EXPIRY_MS) return null;
  const entry = signal.side === "BUY" ? first.open + first.spread : first.open, stopLoss = signal.side === "BUY" ? entry - signal.stopDistance : entry + signal.stopDistance, initialRiskUsd = signal.stopDistance * cashPerPrice(spec) * volume;
  let activeStop = stopLoss, remainingVolume = volume, breakEvenApplied = false, partialApplied = false, partialVolume = 0, partialPnl = 0, structuralTrailUpdates = 0, lastReversalM15CloseChecked = signal.signalTimestamp;
  const trendExit = findTrendExit(signal, m15, m15CloseTimes, ma20);
  for (let index = startIndex; index < m5.length; index += 1) {
    const bar = m5[index]!;
    if (stopTouched(signal.side, bar, activeStop)) return closeTrade(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, bar.closeTime, activeStop, remainingVolume, breakEvenApplied, partialApplied, partialVolume, partialPnl, structuralTrailUpdates, "STOP", spec);
    const favorable = favorableMove(signal.side, entry, bar);
    if (!breakEvenApplied && favorable >= BREAK_EVEN_TRIGGER) { activeStop = improveStop(signal.side, activeStop, entry); breakEvenApplied = true; }
    if (!partialApplied && favorable >= PARTIAL_TRIGGER) {
      const closeVolume = executablePartialVolume(volume, 1 / 3, spec);
      if (closeVolume > 0 && remainingVolume - closeVolume >= spec.minVolume - 1e-9) { const triggerPrice = signal.side === "BUY" ? entry + PARTIAL_TRIGGER : entry - PARTIAL_TRIGGER; partialApplied = true; partialVolume = closeVolume; partialPnl = pnlUsd(signal.side, entry, triggerPrice, closeVolume, spec); remainingVolume = normalizeVolume(remainingVolume - closeVolume, spec.volumeStep); }
    }
    if (partialApplied) {
      const structure = latestConfirmedStructure(signal.side, signal.signalTimestamp, bar.closeTime, swingLows, swingHighs); if (structure !== null) { const improved = improveStop(signal.side, activeStop, structure); if (Math.abs(improved - activeStop) > 1e-9) structuralTrailUpdates += 1; activeStop = improved; }
      const currentM15Index = upperBound(m15CloseTimes, bar.closeTime) - 1;
      if (currentM15Index >= 2) { const currentM15 = m15[currentM15Index]!; if (currentM15.closeTime > lastReversalM15CloseChecked && currentM15.closeTime > signal.signalTimestamp) { lastReversalM15CloseChecked = currentM15.closeTime; if (opposingFvgRejectionAt(signal.side, m15, currentM15Index, REVERSAL_FVG_LOOKBACK)) { const exit = closePriceForSide(signal.side, currentM15.close, currentM15.spread); return closeTrade(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, currentM15.closeTime, exit, remainingVolume, breakEvenApplied, partialApplied, partialVolume, partialPnl, structuralTrailUpdates, "REVERSAL_FVG_REJECTION", spec); } } }
    }
    if (trendExit !== null && bar.closeTime >= trendExit.timestamp) return closeTrade(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, trendExit.timestamp, trendExit.price, remainingVolume, breakEvenApplied, partialApplied, partialVolume, partialPnl, structuralTrailUpdates, "TREND_MA20", spec);
  }
  const last = m5.at(-1)!; const exit = closePriceForSide(signal.side, last.close, last.spread); return closeTrade(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, last.closeTime, exit, remainingVolume, breakEvenApplied, partialApplied, partialVolume, partialPnl, structuralTrailUpdates, "END_OF_DATA", spec);
}

function closeTrade(signal: Signal, entryTime: number, entry: number, stopLoss: number, initialRiskUsd: number, volume: number, exitTime: number, exit: number, remainingVolume: number, breakEvenApplied: boolean, partialApplied: boolean, partialVolume: number, partialPnl: number, structuralTrailUpdates: number, exitReason: ExitReason, spec: Spec): Trade {
  const remainingPnl = pnlUsd(signal.side, entry, exit, remainingVolume, spec), pnl = partialPnl + remainingPnl;
  return { ...signal, entryTime, entry: round(entry, spec.digits), stopLoss: round(stopLoss, spec.digits), initialRiskUsd: round(initialRiskUsd, 2), volume: round(volume, 4), exitTime, exit: round(exit, spec.digits), pnl: round(pnl, 2), rMultiple: round(initialRiskUsd > 0 ? pnl / initialRiskUsd : 0, 4), holdHours: round((exitTime - entryTime) / 3_600_000, 4), breakEvenApplied, partialApplied, partialVolume: round(partialVolume, 4), partialPnl: round(partialPnl, 2), remainingVolumeAtExit: round(remainingVolume, 4), structuralTrailUpdates, exitReason };
}

function summarize(trades: Trade[], skippedWhileOpen: number) {
  const gp = trades.reduce((s, t) => s + Math.max(0, t.pnl), 0), gl = Math.abs(trades.reduce((s, t) => s + Math.min(0, t.pnl), 0)), net = trades.reduce((s, t) => s + t.pnl, 0), wins = trades.filter((t) => t.pnl > 0).length;
  let equity = 0, peak = 0, maxDrawdownUsd = 0; for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) { equity += t.pnl; peak = Math.max(peak, equity); maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - equity); }
  return { trades: trades.length, skippedWhileOpen, winRatePercent: round(trades.length ? wins / trades.length * 100 : 0, 2), netPnl: round(net, 2), profitFactor: gl > 0 ? round(gp / gl, 4) : gp > 0 ? null : 0, expectancy: round(trades.length ? net / trades.length : 0, 4), averageR: round(avg(trades.map((t) => t.rMultiple)), 4), maxDrawdownUsd: round(maxDrawdownUsd, 2), averageHoldHours: round(avg(trades.map((t) => t.holdHours)), 4) };
}

function supertrend(bars: Bar[], period: number, multiplier: number): Array<Direction | null> {
  const tr = bars.map((bar, i) => i === 0 ? bar.high - bar.low : Math.max(bar.high - bar.low, Math.abs(bar.high - bars[i - 1]!.close), Math.abs(bar.low - bars[i - 1]!.close)));
  const atr: Array<number | null> = Array(bars.length).fill(null); if (bars.length >= period) { let sum = 0; for (let i = 0; i < period; i += 1) sum += tr[i]!; atr[period - 1] = sum / period; for (let i = period; i < bars.length; i += 1) atr[i] = (atr[i - 1]! * (period - 1) + tr[i]!) / period; }
  const upper: Array<number | null> = Array(bars.length).fill(null), lower: Array<number | null> = Array(bars.length).fill(null), direction: Array<Direction | null> = Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i += 1) { const bar = bars[i]!, a = atr[i]; if (a === null) continue; const hl2 = (bar.high + bar.low) / 2, bu = hl2 + multiplier * a, bl = hl2 - multiplier * a; if (i === period - 1 || upper[i - 1] === null || lower[i - 1] === null || direction[i - 1] === null) { upper[i] = bu; lower[i] = bl; direction[i] = bar.close >= hl2 ? 1 : -1; continue; } const prev = bars[i - 1]!, pu = upper[i - 1]!, pl = lower[i - 1]!; upper[i] = bu < pu || prev.close > pu ? bu : pu; lower[i] = bl > pl || prev.close < pl ? bl : pl; direction[i] = direction[i - 1] === 1 ? (bar.close < lower[i]! ? -1 : 1) : (bar.close > upper[i]! ? 1 : -1); }
  return direction;
}

function detectPattern(bars: Bar[], index: number): { side: Side; pattern: Pattern; patternExtreme: number } | null {
  const c = bars[index]!, p = bars[index - 1]!;
  if (isBearish(p) && isBullish(c) && c.open <= p.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 && c.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= p.open) return { side: "BUY", pattern: "ENGULFING", patternExtreme: c.low };
  if (isBullish(p) && isBearish(c) && c.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= p.close && c.close <= p.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9) return { side: "SELL", pattern: "ENGULFING", patternExtreme: c.high };
  if (index < 2) return null; const a = bars[index - 2]!, b = bars[index - 1]!, ab = bodySize(a), bb = bodySize(b), combined = bb + bodySize(c);
  if (isBearish(a) && isBullish(b) && isBullish(c) && bb < ab && combined > ab) return { side: "BUY", pattern: "TWO_CANDLE_BODY_DOMINANCE", patternExtreme: Math.min(a.low, b.low, c.low) };
  if (isBullish(a) && isBearish(b) && isBearish(c) && bb < ab && combined > ab) return { side: "SELL", pattern: "TWO_CANDLE_BODY_DOMINANCE", patternExtreme: Math.max(a.high, b.high, c.high) };
  return null;
}

function findTrendExit(signal: Signal, m15: Bar[], closeTimes: number[], ma20: Array<number | null>) { const start = lowerBound(closeTimes, signal.signalTimestamp); for (let i = start + 1; i < m15.length; i += 1) { const bar = m15[i]!, average = ma20[i]; if (!Number.isFinite(average)) continue; if (signal.side === "BUY" ? bar.close < average! : bar.close > average!) return { timestamp: bar.closeTime, price: closePriceForSide(signal.side, bar.close, bar.spread) }; } return null; }
function opposingFvgRejectionAt(side: Side, bars: Bar[], currentIndex: number, lookback: number) { const c = bars[currentIndex]!; if (!(side === "BUY" ? isBearish(c) : isBullish(c))) return false; const start = Math.max(2, currentIndex - lookback); for (let i = currentIndex - 1; i >= start; i -= 1) { const first = bars[i - 2]!, third = bars[i]!; if (side === "BUY" && third.high < first.low) { const lo = third.high, hi = first.low; if (c.high >= lo && c.low <= hi && c.close < hi) return true; } if (side === "SELL" && third.low > first.high) { const lo = first.high, hi = third.low; if (c.high >= lo && c.low <= hi && c.close > lo) return true; } } return false; }
function buildConfirmedSwings(bars: Bar[], side: Side) { const r: Array<{ confirmedAt: number; level: number }> = []; for (let i = 1; i < bars.length - 1; i += 1) { const l = bars[i - 1]!, m = bars[i]!, rr = bars[i + 1]!; if (side === "BUY" && m.low < l.low && m.low <= rr.low) r.push({ confirmedAt: rr.closeTime, level: m.low }); if (side === "SELL" && m.high > l.high && m.high >= rr.high) r.push({ confirmedAt: rr.closeTime, level: m.high }); } return r; }
function latestConfirmedStructure(side: Side, after: number, atOrBefore: number, lows: Array<{ confirmedAt: number; level: number }>, highs: Array<{ confirmedAt: number; level: number }>) { const swings = side === "BUY" ? lows : highs, index = upperBound(swings.map((x) => x.confirmedAt), atOrBefore) - 1; if (index < 0) return null; const item = swings[index]!; return item.confirmedAt > after ? item.level : null; }
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
