export type Phase7DDailyScaleRequest = {
  from: string;
  to: string;
  fixedVolume?: number;
  recoveryMinPrice?: number;
  recoveryMaxPrice?: number;
  profitBufferUsd?: number;
  positiveLockFloorUsd?: number;
  dayUtcOffsetHours?: number;
};

type Side = "BUY" | "SELL";
type Pattern = "ENGULFING" | "TWO_CANDLE_BODY_DOMINANCE";
type LaneName = "CURRENT" | "RECOVERY_LOCK_CURRENT" | "RECOVERY_LOCK_SCALE_BE6" | "RECOVERY_LOCK_SCALE_BE10";

type Bar = { openTime: number; closeTime: number; open: number; high: number; low: number; close: number; spread: number };
type BridgeHealth = { connected: boolean; accountMode: "demo" | "contest" | "real" | null; accountLogin: number | null; server: string | null };
type Spec = {
  brokerSymbol: string; tickSize: number; effectiveTickValuePerLot: number; cashPerPriceUnitPerLot: number;
  digits: number; minVolume: number; maxVolume: number; volumeStep: number;
};
type Signal = { side: Side; pattern: Pattern; signalTimestamp: number; patternExtreme: number; stopDistance: number };
type PreparedSignal = Signal & {
  entryTime: number; entry: number; stopLoss: number; initialRiskUsd: number; volume: number;
  fallbackExitTime: number; fallbackExitPrice: number; canonicalCurrent?: TradeResult;
};
type TrendConfig = { beTrigger: 6 | 10; secondPartial: boolean };
type TradeResult = {
  exitTime: number; exit: number; pnl: number; exitReason: string;
  plus10Reached: boolean; plus20Reached: boolean; firstPartialApplied: boolean; secondPartialApplied: boolean;
  firstPartialPnl: number; secondPartialPnl: number; runnerPnl: number; beStopBefore10: boolean;
};
type Outcome = TradeResult & {
  entryTime: number; side: Side; pattern: Pattern; mode: "CURRENT" | "RECOVERY" | "TREND" | "BLOCKED_POSITIVE_LOCK";
  blocked: boolean; initialRiskUsd: number; dayPnlBeforeEntry: number; recoveryTargetPriceMove: number | null;
};
type DayState = { day: string; pnl: number; trades: number; blocked: number; wentNegative: boolean };
type LaneConfig = { name: LaneName; useRecovery: boolean; usePositiveLock: boolean; trend: TrendConfig };
type Common = {
  fixedVolume: number; recoveryMinPrice: number; recoveryMaxPrice: number; profitBufferUsd: number; positiveLockFloorUsd: number;
  dayUtcOffsetHours: number; cashPerPriceUnitPerLot: number; spec: Spec; m15: Bar[]; m5: Bar[]; m5OpenTimes: number[];
  closeTimes: number[]; ma20: Array<number | null>; swingLows: Array<{ confirmedAt: number; level: number }>;
  swingHighs: Array<{ confirmedAt: number; level: number }>;
};

const DAY_MS = 86_400_000;
const ENGULF_BODY_TOLERANCE_PRICE = 0.1;
const M15_MIN_HISTORY = 200;
const MIN_STOP = 6;
const MAX_STOP = 10;
const FIRST_PARTIAL_TRIGGER = 10;
const SECOND_PARTIAL_TRIGGER = 20;
const REVERSAL_FVG_LOOKBACK = 48;
const ENTRY_EXPIRY_MS = 15 * 60_000;
const MAX_RESEARCH_DAYS = 370;

function bridgeBase() { return (process.env.MT5_BRIDGE_BASE_URL ?? "http://127.0.0.1:8765").trim().replace(/\/$/, ""); }
function bridgeApiKey() {
  const value = process.env.MT5_BRIDGE_API_KEY?.trim() ?? "";
  if (!value) throw new Error("MT5_BRIDGE_API_KEY is not configured for Phase 7D daily scale research.");
  return value;
}
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

export async function runPhase7DDailyScaleResearch(input: Phase7DDailyScaleRequest) {
  const fixedVolume = finite(input.fixedVolume, 0.03);
  const recoveryMinPrice = finite(input.recoveryMinPrice, 6);
  const recoveryMaxPrice = finite(input.recoveryMaxPrice, 10);
  const profitBufferUsd = Math.max(0, finite(input.profitBufferUsd, 3));
  const positiveLockFloorUsd = Math.max(0, finite(input.positiveLockFloorUsd, 0));
  const dayUtcOffsetHours = finite(input.dayUtcOffsetHours, 7);
  if (!(fixedVolume > 0)) throw new Error("fixedVolume must be positive.");
  if (!(recoveryMinPrice > 0) || recoveryMaxPrice < recoveryMinPrice) throw new Error("Recovery range is invalid.");
  if (recoveryMaxPrice > 30) throw new Error("recoveryMaxPrice must be <= 30.");
  if (dayUtcOffsetHours < -12 || dayUtcOffsetHours > 14) throw new Error("dayUtcOffsetHours must be between -12 and +14.");

  const fromMs = Date.parse(input.from);
  const toStartMs = Date.parse(input.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toStartMs)) throw new Error("Invalid from/to date.");
  const toMs = toStartMs + DAY_MS;
  if (fromMs >= toMs) throw new Error("from must be before to.");
  const days = Math.ceil((toMs - fromMs) / DAY_MS);
  if (days > MAX_RESEARCH_DAYS) throw new Error(`Daily scale research supports up to ${MAX_RESEARCH_DAYS} days.`);

  const warmupFromMs = fromMs - 45 * DAY_MS;
  const [health, spec, m15, m5] = await Promise.all([
    bridgeGet<BridgeHealth>("/health", 20_000),
    bridgeGet<Spec>("/v1/symbols/XAUUSD/spec", 20_000),
    bridgeGet<Bar[]>(`/v1/history/candles/XAUUSD?timeframe=M15&fromMs=${warmupFromMs}&toMs=${toMs}`, 60_000),
    bridgeGet<Bar[]>(`/v1/history/candles/XAUUSD?timeframe=M5&fromMs=${fromMs}&toMs=${toMs}`, 90_000),
  ]);
  if (!health.connected || health.accountMode !== "demo") throw new Error("Daily scale research requires a connected DEMO terminal.");
  validateFixedVolume(fixedVolume, spec);
  if (m15.length <= M15_MIN_HISTORY) throw new Error(`Insufficient M15 history (${m15.length} bars).`);
  if (!m5.length) throw new Error("No M5 history returned for selected range.");

  const cashPerPriceUnitPerLot = spec.cashPerPriceUnitPerLot > 0
    ? spec.cashPerPriceUnitPerLot
    : spec.tickSize > 0 ? spec.effectiveTickValuePerLot / spec.tickSize : 0;
  if (!(cashPerPriceUnitPerLot > 0)) throw new Error("Broker cash-per-price-unit value is unavailable.");

  const sortedM15 = [...m15].sort((a, b) => a.openTime - b.openTime);
  const sortedM5 = [...m5].sort((a, b) => a.openTime - b.openTime);
  const m5OpenTimes = sortedM5.map((bar) => bar.openTime);
  const closeTimes = sortedM15.map((bar) => bar.closeTime);
  const closes = sortedM15.map((bar) => bar.close);
  const ma20 = rollingSma(closes, 20);
  const ma50 = rollingSma(closes, 50);
  const ma200 = rollingSma(closes, 200);
  const swingLows = buildConfirmedSwings(sortedM15, "BUY");
  const swingHighs = buildConfirmedSwings(sortedM15, "SELL");

  const signals: Signal[] = [];
  for (let index = M15_MIN_HISTORY; index < sortedM15.length; index += 1) {
    const current = sortedM15[index]!;
    if (current.closeTime < fromMs || current.closeTime >= toMs) continue;
    const trigger = detectPattern(sortedM15, index);
    if (!trigger) continue;
    const a20 = ma20[index], a50 = ma50[index], a200 = ma200[index];
    if (![a20, a50, a200].every(Number.isFinite)) continue;
    if (!trendMatches(trigger.side, current.close, a20!, a50!, a200!)) continue;
    const structuralStopDistance = trigger.side === "BUY" ? current.close - trigger.patternExtreme : trigger.patternExtreme - current.close;
    if (!(structuralStopDistance > 0)) continue;
    signals.push({ side: trigger.side, pattern: trigger.pattern, signalTimestamp: current.closeTime, patternExtreme: trigger.patternExtreme, stopDistance: clamp(structuralStopDistance, MIN_STOP, MAX_STOP) });
  }

  const common: Common = {
    fixedVolume, recoveryMinPrice, recoveryMaxPrice, profitBufferUsd, positiveLockFloorUsd, dayUtcOffsetHours,
    cashPerPriceUnitPerLot, spec, m15: sortedM15, m5: sortedM5, m5OpenTimes, closeTimes, ma20, swingLows, swingHighs,
  };
  const preparedBase = signals
    .map((signal) => prepareSignal(signal, common))
    .filter((value): value is PreparedSignal => value !== null)
    .sort((a, b) => a.signalTimestamp - b.signalTimestamp);
  const prepared = preparedBase.map((candidate) => ({
    ...candidate,
    canonicalCurrent: simulateTrend(candidate, { beTrigger: 6, secondPartial: false }, common),
  }));

  const lanes: LaneConfig[] = [
    { name: "CURRENT", useRecovery: false, usePositiveLock: false, trend: { beTrigger: 6, secondPartial: false } },
    { name: "RECOVERY_LOCK_CURRENT", useRecovery: true, usePositiveLock: true, trend: { beTrigger: 6, secondPartial: false } },
    { name: "RECOVERY_LOCK_SCALE_BE6", useRecovery: true, usePositiveLock: true, trend: { beTrigger: 6, secondPartial: true } },
    { name: "RECOVERY_LOCK_SCALE_BE10", useRecovery: true, usePositiveLock: true, trend: { beTrigger: 10, secondPartial: true } },
  ];
  const results = lanes.map((lane) => simulateLane(prepared, lane, common));
  const current = results.find((item) => item.lane === "CURRENT")!;
  const recoveryLockCurrent = results.find((item) => item.lane === "RECOVERY_LOCK_CURRENT")!;
  const scaleBe6 = results.find((item) => item.lane === "RECOVERY_LOCK_SCALE_BE6")!;
  const scaleBe10 = results.find((item) => item.lane === "RECOVERY_LOCK_SCALE_BE10")!;
  const decision = evaluateDecision(recoveryLockCurrent.metrics, scaleBe6.metrics, scaleBe10.metrics, prepared.length);
  const oneThird = executableOneThird(fixedVolume, spec);

  return {
    source: "PHASE7D_DAILY_RECOVERY_TREND_SCALE_RESEARCH",
    replayMode: "EXACT_PER_LANE_SIGNAL_CONTENTION_WITH_M5_APPROXIMATION",
    generatedAt: Date.now(),
    safety: { researchOnly: true, executionMutation: false, phase7bStrategyMutation: false, fixedVolumeUnchanged: true, liveUnlockAvailable: false, profitGuarantee: false },
    configuration: {
      from: input.from, to: input.to, days, fixedVolume, recoveryMinPrice, recoveryMaxPrice, profitBufferUsd,
      positiveLockFloorUsd, dayUtcOffsetHours, recoveryStopPolicy: "STRUCTURAL_SL_UNTIL_DYNAMIC_FULL_TP_WITH_CANONICAL_EXIT_FALLBACK",
      signals: signals.length, filledCandidates: prepared.length, accountLogin: health.accountLogin, server: health.server,
      volumeStep: spec.volumeStep, firstPartialVolume: round(oneThird, 4), secondPartialVolume: round(oneThird, 4), finalRunnerVolume: round(fixedVolume - 2 * oneThird, 4),
    },
    current, recoveryLockCurrent, scaleBe6, scaleBe10, decision,
    notes: [
      "CURRENT is precomputed once with the canonical +6 BE, +10 one-third partial and canonical runner rules, then reused instead of replaying a duplicate baseline path.",
      "All Recovery+Lock lanes use dynamic full-close Recovery 6-10 while the realized UTC+7 day is negative. Recovery keeps the structural SL until the dynamic target and falls back at the canonical CURRENT trade exit, not a later MA20-only exit.",
      "RECOVERY_LOCK_CURRENT returns to the precomputed canonical current trend outcome once the day is positive.",
      "RECOVERY_LOCK_SCALE_BE6: after the day is positive, +6 BE, +10 close one-third, +20 close another one-third, final one-third runner.",
      "RECOVERY_LOCK_SCALE_BE10: same +10/+20 thirds, but trend-mode BE is delayed to +10. Recovery policy is unchanged.",
      "Positive Lock blocks a new trend-mode trade when its full initial SL risk could reduce an already-positive day to the configured floor or below.",
      "M5 OHLC uses STOP_FIRST when stop and a favorable trigger coexist inside one M5 bar. Commission, swap and exact tick-level slippage are not reconstructed.",
      "Research only. No Phase 7B DEMO order, stop, partial, volume or runtime setting is changed.",
    ],
  };
}

function prepareSignal(signal: Signal, common: Common): PreparedSignal | null {
  const startIndex = lowerBound(common.m5OpenTimes, signal.signalTimestamp);
  const first = common.m5[startIndex];
  if (!first || first.openTime > signal.signalTimestamp + ENTRY_EXPIRY_MS) return null;
  const entry = signal.side === "BUY" ? first.open + first.spread : first.open;
  const stopLoss = signal.side === "BUY" ? entry - signal.stopDistance : entry + signal.stopDistance;
  const trendExit = findTrendExit(signal, common.m15, common.closeTimes, common.ma20);
  const last = common.m5.at(-1)!;
  return {
    ...signal, entryTime: first.openTime, entry, stopLoss,
    initialRiskUsd: signal.stopDistance * common.cashPerPriceUnitPerLot * common.fixedVolume,
    volume: common.fixedVolume,
    fallbackExitTime: trendExit?.timestamp ?? last.closeTime,
    fallbackExitPrice: trendExit?.price ?? closePriceForSide(signal.side, last.close, last.spread),
  };
}

function simulateLane(candidates: PreparedSignal[], lane: LaneConfig, common: Common) {
  const outcomes: Outcome[] = [];
  const days = new Map<string, DayState>();
  let busyUntil = -Infinity;
  let skippedPositionBusy = 0;
  const getDay = (timestamp: number) => {
    const key = dayKey(timestamp, common.dayUtcOffsetHours);
    let state = days.get(key);
    if (!state) { state = { day: key, pnl: 0, trades: 0, blocked: 0, wentNegative: false }; days.set(key, state); }
    return state;
  };

  for (const candidate of candidates) {
    if (candidate.signalTimestamp < busyUntil) { skippedPositionBusy += 1; continue; }
    const entryDay = getDay(candidate.entryTime);
    const dayPnlBeforeEntry = entryDay.pnl;
    const recoveryMode = lane.useRecovery && dayPnlBeforeEntry < 0;
    if (lane.usePositiveLock && !recoveryMode && dayPnlBeforeEntry > common.positiveLockFloorUsd && dayPnlBeforeEntry - candidate.initialRiskUsd <= common.positiveLockFloorUsd) {
      entryDay.blocked += 1;
      outcomes.push({
        entryTime: candidate.entryTime, exitTime: candidate.entryTime, exit: candidate.entry, side: candidate.side, pattern: candidate.pattern,
        pnl: 0, exitReason: "POSITIVE_DAY_LOCK", mode: "BLOCKED_POSITIVE_LOCK", blocked: true,
        initialRiskUsd: round(candidate.initialRiskUsd, 2), dayPnlBeforeEntry: round(dayPnlBeforeEntry, 2), recoveryTargetPriceMove: null,
        plus10Reached: false, plus20Reached: false, firstPartialApplied: false, secondPartialApplied: false,
        firstPartialPnl: 0, secondPartialPnl: 0, runnerPnl: 0, beStopBefore10: false,
      });
      continue;
    }
    const targetMove = recoveryMode
      ? clamp((-dayPnlBeforeEntry + common.profitBufferUsd) / (common.cashPerPriceUnitPerLot * candidate.volume), common.recoveryMinPrice, common.recoveryMaxPrice)
      : null;
    const useCanonicalCurrent = !recoveryMode && lane.trend.beTrigger === 6 && lane.trend.secondPartial === false && candidate.canonicalCurrent;
    const result = recoveryMode
      ? simulateRecovery(candidate, targetMove!, common)
      : useCanonicalCurrent
        ? candidate.canonicalCurrent!
        : simulateTrend(candidate, lane.trend, common);
    busyUntil = result.exitTime;
    const exitDay = getDay(result.exitTime);
    exitDay.pnl += result.pnl; exitDay.trades += 1; if (exitDay.pnl < 0) exitDay.wentNegative = true;
    outcomes.push({
      ...result, entryTime: candidate.entryTime, side: candidate.side, pattern: candidate.pattern,
      mode: lane.name === "CURRENT" ? "CURRENT" : recoveryMode ? "RECOVERY" : "TREND", blocked: false,
      initialRiskUsd: round(candidate.initialRiskUsd, 2), dayPnlBeforeEntry: round(dayPnlBeforeEntry, 2),
      recoveryTargetPriceMove: targetMove === null ? null : round(targetMove, 4),
    });
  }
  const dayRows = [...days.values()].filter((day) => day.trades > 0 || day.blocked > 0).sort((a, b) => a.day.localeCompare(b.day)).map((day) => ({ ...day, pnl: round(day.pnl, 2), recoveredFromNegative: day.wentNegative && day.pnl > 0 }));
  return { lane: lane.name, metrics: summarize(outcomes, dayRows, skippedPositionBusy), days: dayRows.slice(-370).reverse(), outcomes: outcomes.slice(-1500).reverse() };
}

function simulateRecovery(candidate: PreparedSignal, targetMove: number, common: Common): TradeResult {
  const start = lowerBound(common.m5OpenTimes, candidate.entryTime);
  const canonical = candidate.canonicalCurrent;
  const fallbackExitTime = canonical?.exitTime ?? candidate.fallbackExitTime;
  const fallbackExitPrice = canonical?.exit ?? candidate.fallbackExitPrice;
  for (let index = start; index < common.m5.length; index += 1) {
    const bar = common.m5[index]!;
    if (bar.openTime > fallbackExitTime) break;
    if (stopTouched(candidate.side, bar, candidate.stopLoss)) return basicResult(candidate, Math.min(bar.closeTime, fallbackExitTime), candidate.stopLoss, common, "RECOVERY_STOP");
    if (targetTouched(candidate.side, candidate.entry, targetMove, bar)) {
      const exit = candidate.side === "BUY" ? candidate.entry + targetMove : candidate.entry - targetMove;
      return basicResult(candidate, Math.min(bar.closeTime, fallbackExitTime), exit, common, "RECOVERY_TP");
    }
  }
  return basicResult(candidate, fallbackExitTime, fallbackExitPrice, common, "RECOVERY_FALLBACK");
}

function simulateTrend(candidate: PreparedSignal, config: TrendConfig, common: Common): TradeResult {
  const start = lowerBound(common.m5OpenTimes, candidate.entryTime);
  let activeStop = candidate.stopLoss;
  let remainingVolume = candidate.volume;
  let beApplied = false, plus10Reached = false, plus20Reached = false, firstPartialApplied = false, secondPartialApplied = false;
  let firstPartialPnl = 0, secondPartialPnl = 0, lastReversalM15CloseChecked = candidate.signalTimestamp;
  const oneThird = executableOneThird(candidate.volume, common.spec);
  for (let index = start; index < common.m5.length; index += 1) {
    const bar = common.m5[index]!;
    if (bar.openTime > candidate.fallbackExitTime) break;
    if (stopTouched(candidate.side, bar, activeStop)) {
      const runnerPnl = pnlUsd(candidate.side, candidate.entry, activeStop, remainingVolume, common.cashPerPriceUnitPerLot);
      return finish(bar.closeTime, activeStop, firstPartialPnl + secondPartialPnl + runnerPnl, "STOP", plus10Reached, plus20Reached,
        firstPartialApplied, secondPartialApplied, firstPartialPnl, secondPartialPnl, runnerPnl,
        beApplied && !plus10Reached && Math.abs(activeStop - candidate.entry) < 1e-8);
    }
    const favorable = favorableMove(candidate.side, candidate.entry, bar);
    if (!beApplied && favorable >= config.beTrigger) { activeStop = improveStop(candidate.side, activeStop, candidate.entry); beApplied = true; }
    if (!firstPartialApplied && favorable >= FIRST_PARTIAL_TRIGGER) {
      plus10Reached = true;
      if (oneThird > 0 && remainingVolume - oneThird >= common.spec.minVolume - 1e-9) {
        firstPartialApplied = true; firstPartialPnl = FIRST_PARTIAL_TRIGGER * common.cashPerPriceUnitPerLot * oneThird;
        remainingVolume = normalizeVolume(remainingVolume - oneThird, common.spec.volumeStep);
      }
    }
    if (config.secondPartial && !secondPartialApplied && favorable >= SECOND_PARTIAL_TRIGGER) {
      plus20Reached = true;
      if (oneThird > 0 && remainingVolume - oneThird >= common.spec.minVolume - 1e-9) {
        secondPartialApplied = true; secondPartialPnl = SECOND_PARTIAL_TRIGGER * common.cashPerPriceUnitPerLot * oneThird;
        remainingVolume = normalizeVolume(remainingVolume - oneThird, common.spec.volumeStep);
      }
    }
    if (firstPartialApplied) {
      const structure = latestConfirmedStructure(candidate.side, candidate.signalTimestamp, bar.closeTime, common.swingLows, common.swingHighs);
      if (structure !== null) activeStop = improveStop(candidate.side, activeStop, structure);
      const currentM15Index = upperBound(common.closeTimes, bar.closeTime) - 1;
      if (currentM15Index >= 2) {
        const currentM15 = common.m15[currentM15Index]!;
        if (currentM15.closeTime > lastReversalM15CloseChecked && currentM15.closeTime > candidate.signalTimestamp) {
          lastReversalM15CloseChecked = currentM15.closeTime;
          if (opposingFvgRejectionAt(candidate.side, common.m15, currentM15Index, REVERSAL_FVG_LOOKBACK)) {
            const exit = closePriceForSide(candidate.side, currentM15.close, currentM15.spread);
            const runnerPnl = pnlUsd(candidate.side, candidate.entry, exit, remainingVolume, common.cashPerPriceUnitPerLot);
            return finish(currentM15.closeTime, exit, firstPartialPnl + secondPartialPnl + runnerPnl, "REVERSAL_FVG_REJECTION",
              plus10Reached, plus20Reached, firstPartialApplied, secondPartialApplied, firstPartialPnl, secondPartialPnl, runnerPnl, false);
          }
        }
      }
    }
    if (bar.closeTime >= candidate.fallbackExitTime) {
      const runnerPnl = pnlUsd(candidate.side, candidate.entry, candidate.fallbackExitPrice, remainingVolume, common.cashPerPriceUnitPerLot);
      return finish(candidate.fallbackExitTime, candidate.fallbackExitPrice, firstPartialPnl + secondPartialPnl + runnerPnl, "TREND_MA20",
        plus10Reached, plus20Reached, firstPartialApplied, secondPartialApplied, firstPartialPnl, secondPartialPnl, runnerPnl, false);
    }
  }
  const runnerPnl = pnlUsd(candidate.side, candidate.entry, candidate.fallbackExitPrice, remainingVolume, common.cashPerPriceUnitPerLot);
  return finish(candidate.fallbackExitTime, candidate.fallbackExitPrice, firstPartialPnl + secondPartialPnl + runnerPnl, "TREND_MA20",
    plus10Reached, plus20Reached, firstPartialApplied, secondPartialApplied, firstPartialPnl, secondPartialPnl, runnerPnl, false);
}

function basicResult(candidate: PreparedSignal, exitTime: number, exit: number, common: Common, reason: string): TradeResult {
  const pnl = pnlUsd(candidate.side, candidate.entry, exit, candidate.volume, common.cashPerPriceUnitPerLot);
  return finish(exitTime, exit, pnl, reason, false, false, false, false, 0, 0, pnl, false);
}
function finish(exitTime: number, exit: number, pnl: number, exitReason: string, plus10Reached: boolean, plus20Reached: boolean,
  firstPartialApplied: boolean, secondPartialApplied: boolean, firstPartialPnl: number, secondPartialPnl: number, runnerPnl: number, beStopBefore10: boolean): TradeResult {
  return { exitTime, exit: round(exit, 5), pnl: round(pnl, 2), exitReason, plus10Reached, plus20Reached, firstPartialApplied, secondPartialApplied,
    firstPartialPnl: round(firstPartialPnl, 2), secondPartialPnl: round(secondPartialPnl, 2), runnerPnl: round(runnerPnl, 2), beStopBefore10 };
}

function summarize(outcomes: Outcome[], days: Array<DayState & { recoveredFromNegative: boolean }>, skippedPositionBusy: number) {
  const executed = outcomes.filter((item) => !item.blocked);
  const blocked = outcomes.filter((item) => item.blocked);
  const grossProfit = executed.reduce((sum, item) => sum + Math.max(0, item.pnl), 0);
  const grossLoss = Math.abs(executed.reduce((sum, item) => sum + Math.min(0, item.pnl), 0));
  const netPnl = executed.reduce((sum, item) => sum + item.pnl, 0);
  const wins = executed.filter((item) => item.pnl > 0).length;
  let equity = 0, peak = 0, maxDrawdownUsd = 0;
  for (const item of [...executed].sort((a, b) => a.exitTime - b.exitTime)) { equity += item.pnl; peak = Math.max(peak, equity); maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - equity); }
  const daily = days.map((day) => day.pnl);
  const positiveDays = daily.filter((value) => value > 0).length;
  const recovery = executed.filter((item) => item.mode === "RECOVERY");
  const trend = executed.filter((item) => item.mode !== "RECOVERY");
  return {
    trades: executed.length, blockedTrades: blocked.length, skippedPositionBusy,
    winRatePercent: round(executed.length ? wins / executed.length * 100 : 0, 2), netPnl: round(netPnl, 2),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : grossProfit > 0 ? null : 0,
    expectancy: round(executed.length ? netPnl / executed.length : 0, 4), maxDrawdownUsd: round(maxDrawdownUsd, 2),
    activeDays: daily.length, positiveDays, positiveDayRatePercent: round(daily.length ? positiveDays / daily.length * 100 : 0, 2),
    worstDayUsd: round(daily.length ? Math.min(...daily) : 0, 2), averageDailyPnl: round(avg(daily), 2),
    recoveredDays: days.filter((day) => day.recoveredFromNegative).length, recoveryTrades: recovery.length,
    recoveryTpHits: recovery.filter((item) => item.exitReason === "RECOVERY_TP").length,
    recoveryBeExits: recovery.filter((item) => item.exitReason === "RECOVERY_BE").length,
    plus10Hits: trend.filter((item) => item.plus10Reached).length,
    plus10RatePercent: round(trend.length ? trend.filter((item) => item.plus10Reached).length / trend.length * 100 : 0, 2),
    plus20Hits: trend.filter((item) => item.plus20Reached).length,
    plus20RatePercent: round(trend.length ? trend.filter((item) => item.plus20Reached).length / trend.length * 100 : 0, 2),
    beStopsBefore10: trend.filter((item) => item.beStopBefore10).length,
    firstPartialPnl: round(trend.reduce((sum, item) => sum + item.firstPartialPnl, 0), 2),
    secondPartialPnl: round(trend.reduce((sum, item) => sum + item.secondPartialPnl, 0), 2),
    runnerPnl: round(trend.reduce((sum, item) => sum + item.runnerPnl, 0), 2),
  };
}

function evaluateDecision(base: ReturnType<typeof summarize>, be6: ReturnType<typeof summarize>, be10: ReturnType<typeof summarize>, sample: number) {
  const candidates = [score("RECOVERY_LOCK_SCALE_BE6", base, be6), score("RECOVERY_LOCK_SCALE_BE10", base, be10)].sort((a, b) => b.score - a.score);
  const best = candidates[0]!;
  const sufficientSample = sample >= 100 && base.activeDays >= 30;
  const hardPass = best.metrics.netPnl > base.netPnl && (best.metrics.profitFactor ?? 999) >= 1 &&
    best.metrics.maxDrawdownUsd <= base.maxDrawdownUsd * 1.2 + 1e-9 && best.metrics.positiveDayRatePercent >= base.positiveDayRatePercent;
  return {
    sampleTrades: sample, sampleDays: base.activeDays, sufficientSample,
    verdict: !sufficientSample ? "INSUFFICIENT_SAMPLE" : hardPass ? "SCALE_RESEARCH_PROMISING" : "KEEP_CURRENT_RECOVERY_LOCK",
    preferredResearchLane: sufficientSample && hardPass ? best.lane : "RECOVERY_LOCK_CURRENT", executionEligible: false, candidates,
    reason: !sufficientSample ? "Need at least 100 candidates and 30 active days."
      : hardPass ? "A +10/+20 scale lane improves Recovery+Lock economics without worsening drawdown by more than 20% or reducing positive-day rate."
      : "Neither +10/+20 scale lane passes all guards versus current Recovery+Lock in this sample.",
  };
}
function score(lane: string, base: ReturnType<typeof summarize>, metrics: ReturnType<typeof summarize>) {
  let score = 0;
  if (metrics.netPnl > base.netPnl) score += 30;
  if ((metrics.profitFactor ?? 999) >= Math.max(1, base.profitFactor ?? 0)) score += 20;
  if (metrics.maxDrawdownUsd <= base.maxDrawdownUsd) score += 20; else if (metrics.maxDrawdownUsd <= base.maxDrawdownUsd * 1.1) score += 10;
  if (metrics.positiveDayRatePercent >= base.positiveDayRatePercent) score += 20;
  if (metrics.expectancy >= base.expectancy) score += 10;
  return { lane, score, metrics, deltas: {
    netPnl: round(metrics.netPnl - base.netPnl, 2),
    profitFactor: metrics.profitFactor !== null && base.profitFactor !== null ? round(metrics.profitFactor - base.profitFactor, 4) : null,
    maxDrawdownUsd: round(metrics.maxDrawdownUsd - base.maxDrawdownUsd, 2),
    positiveDayRatePercent: round(metrics.positiveDayRatePercent - base.positiveDayRatePercent, 2), expectancy: round(metrics.expectancy - base.expectancy, 4),
  } };
}

function detectPattern(bars: Bar[], index: number): { side: Side; pattern: Pattern; patternExtreme: number } | null {
  const current = bars[index]!, previous = bars[index - 1]!;
  if (isBearish(previous) && isBullish(current) && current.open <= previous.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 && current.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.open)
    return { side: "BUY", pattern: "ENGULFING", patternExtreme: current.low };
  if (isBullish(previous) && isBearish(current) && current.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.close && current.close <= previous.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9)
    return { side: "SELL", pattern: "ENGULFING", patternExtreme: current.high };
  if (index < 2) return null;
  const prior = bars[index - 2]!, first = bars[index - 1]!;
  const priorBody = bodySize(prior), firstBody = bodySize(first), combined = firstBody + bodySize(current);
  if (isBearish(prior) && isBullish(first) && isBullish(current) && firstBody < priorBody && combined > priorBody)
    return { side: "BUY", pattern: "TWO_CANDLE_BODY_DOMINANCE", patternExtreme: Math.min(prior.low, first.low, current.low) };
  if (isBullish(prior) && isBearish(first) && isBearish(current) && firstBody < priorBody && combined > priorBody)
    return { side: "SELL", pattern: "TWO_CANDLE_BODY_DOMINANCE", patternExtreme: Math.max(prior.high, first.high, current.high) };
  return null;
}
function trendMatches(side: Side, close: number, ma20: number, ma50: number, ma200: number) {
  return side === "BUY" ? ma20 > ma50 && ma50 > ma200 && close > ma20 : ma20 < ma50 && ma50 < ma200 && close < ma20;
}
function findTrendExit(signal: Signal, m15: Bar[], closeTimes: number[], ma20: Array<number | null>) {
  const start = lowerBound(closeTimes, signal.signalTimestamp);
  for (let index = start + 1; index < m15.length; index += 1) {
    const bar = m15[index]!, average = ma20[index];
    if (!Number.isFinite(average)) continue;
    if (signal.side === "BUY" ? bar.close < average! : bar.close > average!) return { timestamp: bar.closeTime, price: closePriceForSide(signal.side, bar.close, bar.spread) };
  }
  return null;
}
function opposingFvgRejectionAt(side: Side, bars: Bar[], currentIndex: number, lookback: number) {
  const current = bars[currentIndex]!;
  if (!(side === "BUY" ? isBearish(current) : isBullish(current))) return false;
  const start = Math.max(2, currentIndex - lookback);
  for (let index = currentIndex - 1; index >= start; index -= 1) {
    const first = bars[index - 2]!, third = bars[index]!;
    if (side === "BUY" && third.high < first.low) {
      const zoneLow = third.high, zoneHigh = first.low;
      if (current.high >= zoneLow && current.low <= zoneHigh && current.close < zoneHigh) return true;
    }
    if (side === "SELL" && third.low > first.high) {
      const zoneLow = first.high, zoneHigh = third.low;
      if (current.high >= zoneLow && current.low <= zoneHigh && current.close > zoneLow) return true;
    }
  }
  return false;
}
function buildConfirmedSwings(bars: Bar[], side: Side) {
  const result: Array<{ confirmedAt: number; level: number }> = [];
  for (let index = 1; index < bars.length - 1; index += 1) {
    const left = bars[index - 1]!, middle = bars[index]!, right = bars[index + 1]!;
    if (side === "BUY" && middle.low < left.low && middle.low <= right.low) result.push({ confirmedAt: right.closeTime, level: middle.low });
    if (side === "SELL" && middle.high > left.high && middle.high >= right.high) result.push({ confirmedAt: right.closeTime, level: middle.high });
  }
  return result;
}
function latestConfirmedStructure(side: Side, after: number, atOrBefore: number,
  lows: Array<{ confirmedAt: number; level: number }>, highs: Array<{ confirmedAt: number; level: number }>) {
  const swings = side === "BUY" ? lows : highs;
  const index = upperBound(swings.map((item) => item.confirmedAt), atOrBefore) - 1;
  if (index < 0) return null;
  const item = swings[index]!;
  return item.confirmedAt > after ? item.level : null;
}
function executableOneThird(volume: number, spec: Spec) {
  const value = floorToStep(volume / 3, spec.volumeStep);
  return value < spec.minVolume - 1e-9 ? 0 : value;
}
function targetTouched(side: Side, entry: number, move: number, bar: Bar) { return side === "BUY" ? bar.high >= entry + move - 1e-9 : bar.low + bar.spread <= entry - move + 1e-9; }
function favorableMove(side: Side, entry: number, bar: Bar) { return side === "BUY" ? bar.high - entry : entry - (bar.low + bar.spread); }
function stopTouched(side: Side, bar: Bar, stop: number) { return side === "BUY" ? bar.low <= stop + 1e-9 : bar.high + bar.spread >= stop - 1e-9; }
function closePriceForSide(side: Side, bid: number, spread: number) { return side === "BUY" ? bid : bid + spread; }
function improveStop(side: Side, current: number, candidate: number) { return side === "BUY" ? Math.max(current, candidate) : Math.min(current, candidate); }
function pnlUsd(side: Side, entry: number, exit: number, volume: number, cash: number) { return (side === "BUY" ? exit - entry : entry - exit) * cash * volume; }
function validateFixedVolume(volume: number, spec: Spec) {
  if (volume < spec.minVolume - 1e-9 || volume > spec.maxVolume + 1e-9) throw new Error("fixedVolume is outside broker range.");
  const stepped = Math.round(volume / spec.volumeStep) * spec.volumeStep;
  if (Math.abs(stepped - volume) > spec.volumeStep / 100) throw new Error(`fixedVolume ${volume} is not aligned to volumeStep ${spec.volumeStep}.`);
  const oneThird = executableOneThird(volume, spec);
  if (oneThird <= 0 || volume - 2 * oneThird < spec.minVolume - 1e-9) throw new Error(`fixedVolume ${volume} cannot support +10/+20 one-third scale with broker step ${spec.volumeStep}.`);
}
function rollingSma(values: number[], period: number) {
  const out: Array<number | null> = Array(values.length).fill(null); let sum = 0;
  for (let i = 0; i < values.length; i += 1) { sum += values[i]!; if (i >= period) sum -= values[i - period]!; if (i >= period - 1) out[i] = sum / period; }
  return out;
}
function dayKey(timestamp: number, offset: number) { return new Date(timestamp + offset * 3_600_000).toISOString().slice(0, 10); }
function lowerBound(values: number[], target: number) { let low = 0, high = values.length; while (low < high) { const mid = (low + high) >>> 1; if (values[mid]! < target) low = mid + 1; else high = mid; } return low; }
function upperBound(values: number[], target: number) { let low = 0, high = values.length; while (low < high) { const mid = (low + high) >>> 1; if (values[mid]! <= target) low = mid + 1; else high = mid; } return low; }
function isBullish(bar: Bar) { return bar.close > bar.open; }
function isBearish(bar: Bar) { return bar.close < bar.open; }
function bodySize(bar: Bar) { return Math.abs(bar.close - bar.open); }
function finite(value: number | undefined, fallback: number) { return Number.isFinite(value) ? Number(value) : fallback; }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
function avg(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function round(value: number, digits: number) { const factor = 10 ** digits; return Math.round((value + Number.EPSILON) * factor) / factor; }
function floorToStep(value: number, step: number) { return step > 0 ? Math.floor((value + 1e-12) / step) * step : value; }
function normalizeVolume(value: number, step: number) { return round(Math.max(0, Math.round(value / step) * step), 8); }
