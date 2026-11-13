export type Phase7DDailyPnlRequest = {
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
type ExitReason = "STOP" | "TREND_MA20" | "REVERSAL_FVG_REJECTION" | "END_OF_DATA";
type LaneName = "BASELINE" | "RECOVERY" | "TREND_PLUS_LOCK" | "RECOVERY_PLUS_LOCK";

type Bar = {
  symbol?: string;
  brokerSymbol?: string;
  timeframe?: string;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  spread: number;
};

type BridgeHealth = {
  connected: boolean;
  accountMode: "demo" | "contest" | "real" | null;
  accountLogin: number | null;
  server: string | null;
};

type Spec = {
  brokerSymbol: string;
  tickSize: number;
  effectiveTickValuePerLot: number;
  cashPerPriceUnitPerLot: number;
  digits: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
};

type Signal = {
  side: Side;
  pattern: Pattern;
  signalTimestamp: number;
  referenceEntry: number;
  patternExtreme: number;
  structuralStopDistance: number;
  stopDistance: number;
  fvgConfirmedAtEntry: boolean;
  ma20: number;
  ma50: number;
  ma200: number;
};

type CandidateTrade = Signal & {
  entryTime: number;
  entry: number;
  stopLoss: number;
  initialRiskUsd: number;
  volume: number;
  exitTime: number;
  exit: number;
  pnl: number;
  rMultiple: number;
  holdHours: number;
  breakEvenApplied: boolean;
  partialApplied: boolean;
  partialVolume: number;
  partialPnl: number;
  remainingVolumeAtExit: number;
  structuralTrailUpdates: number;
  exitReason: ExitReason;
};

type Outcome = {
  entryTime: number;
  exitTime: number;
  side: Side;
  pattern: string;
  pnl: number;
  mode: "BASELINE" | "RECOVERY" | "TREND" | "BLOCKED_POSITIVE_LOCK";
  exitReason: string;
  recoveryTargetPriceMove: number | null;
  dayPnlBeforeEntry: number;
  initialRiskUsd: number;
  blocked: boolean;
  counterfactualCanonicalPnl: number | null;
};

type DayState = {
  day: string;
  pnl: number;
  trades: number;
  blocked: number;
  recoveryTrades: number;
  wentNegative: boolean;
};

type LaneConfig = {
  name: LaneName;
  useRecovery: boolean;
  usePositiveLock: boolean;
};

type Common = {
  recoveryMinPrice: number;
  recoveryMaxPrice: number;
  profitBufferUsd: number;
  positiveLockFloorUsd: number;
  dayUtcOffsetHours: number;
  cashPerPriceUnitPerLot: number;
  m5: Bar[];
  m5OpenTimes: number[];
};

const DAY_MS = 86_400_000;
const ENGULF_BODY_TOLERANCE_PRICE = 0.1;
const M15_MIN_HISTORY = 200;
const MIN_STOP = 6;
const MAX_STOP = 10;
const BREAK_EVEN_TRIGGER = 6;
const PARTIAL_TRIGGER = 10;
const FVG_LOOKBACK = 12;
const REVERSAL_FVG_LOOKBACK = 48;
const ENTRY_EXPIRY_MS = 15 * 60_000;
const MAX_RESEARCH_DAYS = 370;

function bridgeBase(): string {
  return (process.env.MT5_BRIDGE_BASE_URL ?? "http://127.0.0.1:8765").trim().replace(/\/$/, "");
}

function bridgeApiKey(): string {
  const value = process.env.MT5_BRIDGE_API_KEY?.trim() ?? "";
  if (!value) throw new Error("MT5_BRIDGE_API_KEY is not configured for Phase 7D.");
  return value;
}

async function bridgeGet<T>(path: string, timeoutMs = 60_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${bridgeBase()}${path}`, {
      headers: { "x-mt5-api-key": bridgeApiKey() },
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`MT5 bridge ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runPhase7DDailyPnlResearch(input: Phase7DDailyPnlRequest) {
  const fixedVolume = finite(input.fixedVolume, 0.03);
  const recoveryMinPrice = finite(input.recoveryMinPrice, 6);
  const recoveryMaxPrice = finite(input.recoveryMaxPrice, 10);
  const profitBufferUsd = Math.max(0, finite(input.profitBufferUsd, 3));
  const positiveLockFloorUsd = Math.max(0, finite(input.positiveLockFloorUsd, 0));
  const dayUtcOffsetHours = finite(input.dayUtcOffsetHours, 7);

  if (!(fixedVolume > 0)) throw new Error("fixedVolume must be positive.");
  if (!(recoveryMinPrice > 0) || !(recoveryMaxPrice >= recoveryMinPrice)) {
    throw new Error("Recovery price range is invalid.");
  }
  if (recoveryMaxPrice > 30) throw new Error("recoveryMaxPrice must be <= 30.");
  if (dayUtcOffsetHours < -12 || dayUtcOffsetHours > 14) {
    throw new Error("dayUtcOffsetHours must be between -12 and +14.");
  }

  const fromMs = Date.parse(input.from);
  const toStartMs = Date.parse(input.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toStartMs)) throw new Error("Invalid from/to date.");
  const toMs = toStartMs + DAY_MS;
  if (fromMs >= toMs) throw new Error("from must be before to.");
  const days = Math.ceil((toMs - fromMs) / DAY_MS);
  if (days > MAX_RESEARCH_DAYS) throw new Error(`Phase 7D supports up to ${MAX_RESEARCH_DAYS} days per run.`);

  const warmupFromMs = fromMs - 45 * DAY_MS;
  const [health, spec, m15, m5] = await Promise.all([
    bridgeGet<BridgeHealth>("/health", 20_000),
    bridgeGet<Spec>("/v1/symbols/XAUUSD/spec", 20_000),
    bridgeGet<Bar[]>(`/v1/history/candles/XAUUSD?timeframe=M15&fromMs=${warmupFromMs}&toMs=${toMs}`, 60_000),
    bridgeGet<Bar[]>(`/v1/history/candles/XAUUSD?timeframe=M5&fromMs=${fromMs}&toMs=${toMs}`, 90_000),
  ]);

  if (!health.connected || health.accountMode !== "demo") {
    throw new Error("Phase 7D exact replay requires a connected DEMO terminal.");
  }
  if (m15.length <= M15_MIN_HISTORY) throw new Error(`Insufficient M15 history (${m15.length} bars).`);
  if (m5.length === 0) throw new Error("No M5 history returned for selected range.");
  validateFixedVolume(fixedVolume, spec);

  const cashPerPriceUnitPerLot = spec.cashPerPriceUnitPerLot > 0
    ? spec.cashPerPriceUnitPerLot
    : spec.tickSize > 0
      ? spec.effectiveTickValuePerLot / spec.tickSize
      : 0;
  if (!(cashPerPriceUnitPerLot > 0)) throw new Error("Broker cash-per-price-unit value is unavailable.");

  const sortedM15 = [...m15].sort((a, b) => a.openTime - b.openTime);
  const sortedM5 = [...m5].sort((a, b) => a.openTime - b.openTime);
  const m5OpenTimes = sortedM5.map((bar) => bar.openTime);
  const closes = sortedM15.map((bar) => bar.close);
  const ma20 = rollingSma(closes, 20);
  const ma50 = rollingSma(closes, 50);
  const ma200 = rollingSma(closes, 200);
  const closeTimes = sortedM15.map((bar) => bar.closeTime);
  const swingLows = buildConfirmedSwings(sortedM15, "BUY");
  const swingHighs = buildConfirmedSwings(sortedM15, "SELL");

  const signals: Signal[] = [];
  for (let index = M15_MIN_HISTORY; index < sortedM15.length; index += 1) {
    const current = sortedM15[index]!;
    if (current.closeTime < fromMs || current.closeTime >= toMs) continue;
    const trigger = detectPattern(sortedM15, index);
    if (!trigger) continue;
    const a20 = ma20[index];
    const a50 = ma50[index];
    const a200 = ma200[index];
    if (![a20, a50, a200].every(Number.isFinite)) continue;
    if (!trendMatches(trigger.side, current.close, a20!, a50!, a200!)) continue;
    const structuralStopDistance = trigger.side === "BUY"
      ? current.close - trigger.patternExtreme
      : trigger.patternExtreme - current.close;
    if (!(structuralStopDistance > 0)) continue;
    signals.push({
      side: trigger.side,
      pattern: trigger.pattern,
      signalTimestamp: current.closeTime,
      referenceEntry: round(current.close, 5),
      patternExtreme: round(trigger.patternExtreme, 5),
      structuralStopDistance: round(structuralStopDistance, 5),
      stopDistance: round(clamp(structuralStopDistance, MIN_STOP, MAX_STOP), 5),
      fvgConfirmedAtEntry: hasRelevantFvg(sortedM15, index, trigger.side, FVG_LOOKBACK),
      ma20: round(a20!, 5),
      ma50: round(a50!, 5),
      ma200: round(a200!, 5),
    });
  }

  const candidateTrades = signals
    .map((signal) => simulateCanonicalTrade(
      signal,
      sortedM15,
      sortedM5,
      m5OpenTimes,
      closeTimes,
      ma20,
      spec,
      fixedVolume,
      swingLows,
      swingHighs,
    ))
    .filter((trade): trade is CandidateTrade => trade !== null)
    .sort((a, b) => a.signalTimestamp - b.signalTimestamp);

  const common: Common = {
    recoveryMinPrice,
    recoveryMaxPrice,
    profitBufferUsd,
    positiveLockFloorUsd,
    dayUtcOffsetHours,
    cashPerPriceUnitPerLot,
    m5: sortedM5,
    m5OpenTimes,
  };

  const baseline = simulateLane(candidateTrades, { name: "BASELINE", useRecovery: false, usePositiveLock: false }, common);
  const recovery = simulateLane(candidateTrades, { name: "RECOVERY", useRecovery: true, usePositiveLock: false }, common);
  const trendPlusLock = simulateLane(candidateTrades, { name: "TREND_PLUS_LOCK", useRecovery: false, usePositiveLock: true }, common);
  const recoveryPlusLock = simulateLane(candidateTrades, { name: "RECOVERY_PLUS_LOCK", useRecovery: true, usePositiveLock: true }, common);
  const decision = evaluateDecision(
    baseline.metrics,
    recovery.metrics,
    trendPlusLock.metrics,
    recoveryPlusLock.metrics,
    candidateTrades.length,
  );

  return {
    source: "PHASE7D_DAILY_PNL_RESEARCH",
    generatedAt: Date.now(),
    replayMode: "EXACT_PER_LANE_SIGNAL_CONTENTION_WITH_M5_APPROXIMATION",
    safety: {
      researchOnly: true,
      executionMutation: false,
      phase7bStrategyMutation: false,
      fixedVolumeUnchanged: true,
      liveUnlockAvailable: false,
      profitGuarantee: false,
    },
    configuration: {
      from: input.from,
      to: input.to,
      fixedVolume,
      recoveryMinPrice,
      recoveryMaxPrice,
      profitBufferUsd,
      positiveLockFloorUsd,
      dayUtcOffsetHours,
      recoveryStopPolicy: "STRUCTURAL_SL_UNTIL_DYNAMIC_FULL_TP",
      comparedTradeSchedule: candidateTrades.length,
      fullPeriodCanonicalTrades: baseline.metrics.trades,
      journalTradeLimitApplied: false,
      signals: signals.length,
      filledCandidateTrades: candidateTrades.length,
      baselineSkippedPositionBusy: baseline.metrics.skippedPositionBusy,
      recoverySkippedPositionBusy: recovery.metrics.skippedPositionBusy,
      trendPlusLockSkippedPositionBusy: trendPlusLock.metrics.skippedPositionBusy,
      recoveryPlusLockSkippedPositionBusy: recoveryPlusLock.metrics.skippedPositionBusy,
      accountLogin: health.accountLogin,
      server: health.server,
    },
    baseline,
    recovery,
    trendPlusLock,
    recoveryPlusLock,
    decision,
    notes: [
      "Phase 7D exact signal isolation: every lane starts from the same full Pattern+MA candidate stream and maintains its own max-one-position busyUntil state.",
      "TREND_PLUS_LOCK isolates Positive Lock without Recovery. RECOVERY_PLUS_LOCK measures the combined effect.",
      "For every Positive Lock block, counterfactualCanonicalPnl records that candidate's isolated canonical outcome. This diagnoses whether Lock blocks winners or losers, but it is not a full alternate-path replay because executing a blocked trade would change later signal contention.",
      "If Recovery exits earlier, later signals become eligible in that lane. If Positive Lock blocks a candidate, later signals remain eligible because no position was opened.",
      "Canonical trend-mode management mirrors Phase 7B research rules: +6 BE, +10 one-third partial, confirmed M15 structure trail, opposing-FVG rejection, MA20 fallback.",
      "Recovery mode is used only when realized P/L of the UTC+7 trading day is negative at entry. The full-exit target is dynamically calculated to recover the day plus the configured buffer and then clamped to the configured 6-10 price range.",
      "Recovery mode keeps the original structural SL until the dynamic full-close target is reached; it does NOT move SL to Entry at +6. This isolates the user's recovery rule from canonical Trend Mode management.",
      "Positive Lock blocks a new trend-mode trade when its initial SL risk could reduce an already-positive day to the configured floor or below.",
      "Research only: no Phase 7B DEMO order, stop, volume or management setting is changed. A positive day is a target, not a guarantee.",
      "M5 OHLC with broker spread is still an intrabar approximation; STOP_FIRST is used when a single M5 bar contains conflicting paths.",
      "Commission, swap and exact tick-level slippage are not reconstructed.",
    ],
  };
}

function simulateLane(candidates: CandidateTrade[], lane: LaneConfig, common: Common) {
  const dayStates = new Map<string, DayState>();
  const outcomes: Outcome[] = [];
  let busyUntil = -Infinity;
  let skippedPositionBusy = 0;

  const getDay = (timestamp: number) => {
    const key = dayKey(timestamp, common.dayUtcOffsetHours);
    let state = dayStates.get(key);
    if (!state) {
      state = { day: key, pnl: 0, trades: 0, blocked: 0, recoveryTrades: 0, wentNegative: false };
      dayStates.set(key, state);
    }
    return state;
  };

  for (const trade of candidates) {
    if (trade.signalTimestamp < busyUntil) {
      skippedPositionBusy += 1;
      continue;
    }

    const entryDay = getDay(trade.entryTime);
    const dayPnlBeforeEntry = entryDay.pnl;
    const initialRiskUsd = trade.initialRiskUsd;
    const recoveryMode = lane.useRecovery && dayPnlBeforeEntry < 0;
    const trendMode = !recoveryMode;

    if (
      lane.usePositiveLock &&
      trendMode &&
      dayPnlBeforeEntry > common.positiveLockFloorUsd &&
      dayPnlBeforeEntry - initialRiskUsd <= common.positiveLockFloorUsd
    ) {
      entryDay.blocked += 1;
      outcomes.push({
        entryTime: trade.entryTime,
        exitTime: trade.entryTime,
        side: trade.side,
        pattern: trade.pattern,
        pnl: 0,
        mode: "BLOCKED_POSITIVE_LOCK",
        exitReason: "POSITIVE_DAY_LOCK",
        recoveryTargetPriceMove: null,
        dayPnlBeforeEntry: round(dayPnlBeforeEntry, 2),
        initialRiskUsd: round(initialRiskUsd, 2),
        blocked: true,
        counterfactualCanonicalPnl: round(trade.pnl, 2),
      });
      continue;
    }

    let result: { pnl: number; exitTime: number; exitReason: string; targetMove: number | null };
    if (recoveryMode) {
      const requiredMove = (-dayPnlBeforeEntry + common.profitBufferUsd) /
        (common.cashPerPriceUnitPerLot * trade.volume);
      const targetMove = clamp(requiredMove, common.recoveryMinPrice, common.recoveryMaxPrice);
      result = simulateRecoveryTrade(trade, targetMove, common);
      entryDay.recoveryTrades += 1;
    } else {
      result = {
        pnl: trade.pnl,
        exitTime: trade.exitTime,
        exitReason: `CANONICAL_${trade.exitReason}`,
        targetMove: null,
      };
    }

    busyUntil = result.exitTime;
    const exitDay = getDay(result.exitTime);
    exitDay.pnl += result.pnl;
    exitDay.trades += 1;
    if (exitDay.pnl < 0) exitDay.wentNegative = true;

    outcomes.push({
      entryTime: trade.entryTime,
      exitTime: result.exitTime,
      side: trade.side,
      pattern: trade.pattern,
      pnl: round(result.pnl, 2),
      mode: lane.name === "BASELINE" ? "BASELINE" : recoveryMode ? "RECOVERY" : "TREND",
      exitReason: result.exitReason,
      recoveryTargetPriceMove: result.targetMove === null ? null : round(result.targetMove, 4),
      dayPnlBeforeEntry: round(dayPnlBeforeEntry, 2),
      initialRiskUsd: round(initialRiskUsd, 2),
      blocked: false,
      counterfactualCanonicalPnl: null,
    });
  }

  const days = [...dayStates.values()]
    .filter((day) => day.trades > 0 || day.blocked > 0)
    .sort((left, right) => left.day.localeCompare(right.day))
    .map((day) => ({
      ...day,
      pnl: round(day.pnl, 2),
      recoveredFromNegative: day.wentNegative && day.pnl > 0,
    }));

  return {
    lane: lane.name,
    metrics: summarizeLane(outcomes, days, skippedPositionBusy, common.dayUtcOffsetHours),
    days: days.slice(-370).reverse(),
    outcomes: outcomes.slice(-1500).reverse(),
  };
}

function simulateRecoveryTrade(trade: CandidateTrade, targetMove: number, common: Common) {
  const start = lowerBound(common.m5OpenTimes, trade.entryTime);
  const structuralStop = trade.stopLoss;

  for (let index = start; index < common.m5.length; index += 1) {
    const bar = common.m5[index]!;
    if (bar.openTime > trade.exitTime) break;

    if (stopTouched(trade.side, bar, structuralStop)) {
      return {
        pnl: pnlUsdCash(trade.side, trade.entry, structuralStop, trade.volume, common.cashPerPriceUnitPerLot),
        exitTime: Math.min(bar.closeTime, trade.exitTime),
        exitReason: "RECOVERY_STOP",
        targetMove,
      };
    }

    if (targetTouched(trade.side, trade.entry, targetMove, bar)) {
      return {
        pnl: targetMove * common.cashPerPriceUnitPerLot * trade.volume,
        exitTime: Math.min(bar.closeTime, trade.exitTime),
        exitReason: "RECOVERY_TP",
        targetMove,
      };
    }
  }

  return {
    pnl: pnlUsdCash(trade.side, trade.entry, trade.exit, trade.volume, common.cashPerPriceUnitPerLot),
    exitTime: trade.exitTime,
    exitReason: "RECOVERY_CANONICAL_TIME_FALLBACK",
    targetMove,
  };
}

function simulateCanonicalTrade(
  signal: Signal,
  m15: Bar[],
  m5: Bar[],
  m5OpenTimes: number[],
  closeTimes: number[],
  ma20: Array<number | null>,
  spec: Spec,
  volume: number,
  swingLows: Array<{ confirmedAt: number; level: number }>,
  swingHighs: Array<{ confirmedAt: number; level: number }>,
): CandidateTrade | null {
  const startIndex = lowerBound(m5OpenTimes, signal.signalTimestamp);
  const first = m5[startIndex];
  if (!first || first.openTime > signal.signalTimestamp + ENTRY_EXPIRY_MS) return null;

  const entry = signal.side === "BUY" ? first.open + first.spread : first.open;
  const stopLoss = signal.side === "BUY" ? entry - signal.stopDistance : entry + signal.stopDistance;
  const initialRiskUsd = pnlAbs(signal.stopDistance, volume, spec);
  let activeStop = stopLoss;
  let remainingVolume = volume;
  let breakEvenApplied = false;
  let partialApplied = false;
  let partialVolume = 0;
  let partialPnl = 0;
  let structuralTrailUpdates = 0;
  let lastReversalM15CloseChecked = signal.signalTimestamp;
  const trendExit = findTrendExit(signal, m15, closeTimes, ma20);

  for (let index = startIndex; index < m5.length; index += 1) {
    const bar = m5[index]!;
    if (stopTouched(signal.side, bar, activeStop)) {
      return closeCandidate(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, bar.closeTime, activeStop,
        remainingVolume, breakEvenApplied, partialApplied, partialVolume, partialPnl, structuralTrailUpdates, "STOP", spec);
    }

    const favorable = favorableMove(signal.side, entry, bar);
    if (!breakEvenApplied && favorable >= BREAK_EVEN_TRIGGER) {
      activeStop = improveStop(signal.side, activeStop, entry);
      breakEvenApplied = true;
    }

    if (!partialApplied && favorable >= PARTIAL_TRIGGER) {
      const closeVolume = partialCloseVolume(volume, remainingVolume, spec);
      if (closeVolume > 0) {
        const triggerPrice = signal.side === "BUY" ? entry + PARTIAL_TRIGGER : entry - PARTIAL_TRIGGER;
        partialApplied = true;
        partialVolume = closeVolume;
        partialPnl = pnlUsdSpec(signal.side, entry, triggerPrice, closeVolume, spec);
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
      const currentM15Index = upperBound(closeTimes, bar.closeTime) - 1;
      if (currentM15Index >= 2) {
        const currentM15 = m15[currentM15Index]!;
        if (currentM15.closeTime > lastReversalM15CloseChecked && currentM15.closeTime > signal.signalTimestamp) {
          lastReversalM15CloseChecked = currentM15.closeTime;
          if (opposingFvgRejectionAt(signal.side, m15, currentM15Index, REVERSAL_FVG_LOOKBACK)) {
            const exit = closePriceForSide(signal.side, currentM15.close, currentM15.spread);
            return closeCandidate(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, currentM15.closeTime, exit,
              remainingVolume, breakEvenApplied, partialApplied, partialVolume, partialPnl, structuralTrailUpdates,
              "REVERSAL_FVG_REJECTION", spec);
          }
        }
      }
    }

    if (trendExit !== null && bar.closeTime >= trendExit.timestamp) {
      return closeCandidate(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, trendExit.timestamp, trendExit.price,
        remainingVolume, breakEvenApplied, partialApplied, partialVolume, partialPnl, structuralTrailUpdates, "TREND_MA20", spec);
    }
  }

  const last = m5.at(-1)!;
  const exit = closePriceForSide(signal.side, last.close, last.spread);
  return closeCandidate(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, last.closeTime, exit,
    remainingVolume, breakEvenApplied, partialApplied, partialVolume, partialPnl, structuralTrailUpdates, "END_OF_DATA", spec);
}

function closeCandidate(
  signal: Signal,
  entryTime: number,
  entry: number,
  stopLoss: number,
  initialRiskUsd: number,
  volume: number,
  exitTime: number,
  exit: number,
  remainingVolume: number,
  breakEvenApplied: boolean,
  partialApplied: boolean,
  partialVolume: number,
  partialPnl: number,
  structuralTrailUpdates: number,
  exitReason: ExitReason,
  spec: Spec,
): CandidateTrade {
  const remainingPnl = pnlUsdSpec(signal.side, entry, exit, remainingVolume, spec);
  const pnl = partialPnl + remainingPnl;
  return {
    ...signal,
    entryTime,
    entry: round(entry, spec.digits),
    stopLoss: round(stopLoss, spec.digits),
    initialRiskUsd: round(initialRiskUsd, 2),
    volume: round(volume, 4),
    exitTime,
    exit: round(exit, spec.digits),
    pnl: round(pnl, 2),
    rMultiple: round(initialRiskUsd > 0 ? pnl / initialRiskUsd : 0, 4),
    holdHours: round((exitTime - entryTime) / 3_600_000, 4),
    breakEvenApplied,
    partialApplied,
    partialVolume: round(partialVolume, 4),
    partialPnl: round(partialPnl, 2),
    remainingVolumeAtExit: round(remainingVolume, 4),
    structuralTrailUpdates,
    exitReason,
  };
}

function summarizeLane(
  outcomes: Outcome[],
  days: Array<DayState & { recoveredFromNegative: boolean }>,
  skippedPositionBusy: number,
  dayUtcOffsetHours: number,
) {
  const executed = outcomes.filter((item) => !item.blocked);
  const blocked = outcomes.filter((item) => item.blocked);
  const wins = executed.filter((item) => item.pnl > 0).length;
  const grossProfit = executed.reduce((sum, item) => sum + Math.max(0, item.pnl), 0);
  const grossLoss = Math.abs(executed.reduce((sum, item) => sum + Math.min(0, item.pnl), 0));
  const netPnl = executed.reduce((sum, item) => sum + item.pnl, 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdownUsd = 0;
  for (const item of [...executed].sort((left, right) => left.exitTime - right.exitTime)) {
    equity += item.pnl;
    peak = Math.max(peak, equity);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - equity);
  }

  const daily = days.map((day) => day.pnl);
  const positiveDays = daily.filter((value) => value > 0).length;
  const negativeDays = daily.filter((value) => value < 0).length;
  const flatDays = daily.length - positiveDays - negativeDays;
  const recoveryTargets = executed
    .map((item) => item.recoveryTargetPriceMove)
    .filter((value): value is number => value !== null);
  const positiveLockBlocked = blocked.filter((item) => item.exitReason === "POSITIVE_DAY_LOCK");
  const blockedPnl = positiveLockBlocked
    .map((item) => item.counterfactualCanonicalPnl)
    .filter((value): value is number => value !== null);
  const blockedWins = blockedPnl.filter((value) => value > 0).length;
  const blockedGrossProfit = blockedPnl.reduce((sum, value) => sum + Math.max(0, value), 0);
  const blockedGrossLoss = Math.abs(blockedPnl.reduce((sum, value) => sum + Math.min(0, value), 0));
  const blockedNetPnl = blockedPnl.reduce((sum, value) => sum + value, 0);

  return {
    trades: executed.length,
    blockedTrades: blocked.length,
    skippedPositionBusy,
    winRatePercent: round(executed.length ? wins / executed.length * 100 : 0, 2),
    netPnl: round(netPnl, 2),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : grossProfit > 0 ? null : 0,
    expectancy: round(executed.length ? netPnl / executed.length : 0, 4),
    maxDrawdownUsd: round(maxDrawdownUsd, 2),
    activeDays: daily.length,
    positiveDays,
    negativeDays,
    flatDays,
    positiveDayRatePercent: round(daily.length ? positiveDays / daily.length * 100 : 0, 2),
    averageDailyPnl: round(avg(daily), 2),
    medianDailyPnl: round(median(daily), 2),
    bestDayUsd: round(daily.length ? Math.max(...daily) : 0, 2),
    worstDayUsd: round(daily.length ? Math.min(...daily) : 0, 2),
    maxConsecutiveLosingDays: maxConsecutiveLosingDays(daily),
    recoveredDays: days.filter((day) => day.recoveredFromNegative).length,
    recoveryTrades: executed.filter((item) => item.mode === "RECOVERY").length,
    recoveryTpHits: executed.filter((item) => item.exitReason === "RECOVERY_TP").length,
    recoveryBeExits: executed.filter((item) => item.exitReason === "RECOVERY_BE").length,
    averageRecoveryTargetPrice: round(avg(recoveryTargets), 4),
    positiveLockBlockedTrades: positiveLockBlocked.length,
    positiveLockBlockedDays: new Set(positiveLockBlocked.map((item) => dayKey(item.entryTime, dayUtcOffsetHours))).size,
    blockedCounterfactualWinRatePercent: round(blockedPnl.length ? blockedWins / blockedPnl.length * 100 : 0, 2),
    blockedCounterfactualNetPnl: round(blockedNetPnl, 2),
    blockedCounterfactualProfitFactor: blockedGrossLoss > 0
      ? round(blockedGrossProfit / blockedGrossLoss, 4)
      : blockedGrossProfit > 0 ? null : 0,
    blockedCounterfactualGrossProfit: round(blockedGrossProfit, 2),
    blockedCounterfactualGrossLoss: round(blockedGrossLoss, 2),
    blockedInitialRiskUsd: round(positiveLockBlocked.reduce((sum, item) => sum + item.initialRiskUsd, 0), 2),
    lockEstimatedPnlSavedUsd: round(-blockedNetPnl, 2),
  };
}

function evaluateDecision(
  baseline: ReturnType<typeof summarizeLane>,
  recovery: ReturnType<typeof summarizeLane>,
  trendPlusLock: ReturnType<typeof summarizeLane>,
  recoveryPlusLock: ReturnType<typeof summarizeLane>,
  candidateTrades: number,
) {
  const candidates = [
    scoreCandidate("RECOVERY", baseline, recovery),
    scoreCandidate("TREND_PLUS_LOCK", baseline, trendPlusLock),
    scoreCandidate("RECOVERY_PLUS_LOCK", baseline, recoveryPlusLock),
  ].sort((left, right) => right.score - left.score);
  const best = candidates[0]!;
  const sufficientSample = candidateTrades >= 100 && baseline.activeDays >= 30;
  const hardPass =
    best.metrics.netPnl > baseline.netPnl &&
    (best.metrics.profitFactor ?? 999) >= 1 &&
    best.metrics.positiveDayRatePercent > baseline.positiveDayRatePercent &&
    best.metrics.maxDrawdownUsd <= baseline.maxDrawdownUsd * 1.2 + 1e-9;

  return {
    sampleTrades: candidateTrades,
    sampleDays: baseline.activeDays,
    sufficientSample,
    recommendedLane: sufficientSample && hardPass ? best.lane : "KEEP_BASELINE_RESEARCH",
    verdict: !sufficientSample
      ? "INSUFFICIENT_SAMPLE"
      : hardPass
        ? "RESEARCH_PROMISING"
        : "NO_CLEAR_IMPROVEMENT",
    executionEligible: false,
    bestResearchScore: best.score,
    candidates,
    lockIsolation: {
      trendPlusLockScore: candidates.find((item) => item.lane === "TREND_PLUS_LOCK")?.score ?? 0,
      recoveryPlusLockScore: candidates.find((item) => item.lane === "RECOVERY_PLUS_LOCK")?.score ?? 0,
      interpretation: classifyLockContribution(trendPlusLock, recoveryPlusLock),
    },
    reason: !sufficientSample
      ? "Need at least 100 filled candidate trades and 30 active baseline days before judging daily P/L controls."
      : hardPass
        ? "Best exact-signal research lane improves positive-day rate and total economics without increasing max drawdown by more than 20%."
        : "No exact-signal candidate passes all research guards at the same time; keep Phase 7B execution unchanged.",
  };
}

function scoreCandidate(
  lane: Exclude<LaneName, "BASELINE">,
  baseline: ReturnType<typeof summarizeLane>,
  metrics: ReturnType<typeof summarizeLane>,
) {
  let score = 0;
  const positiveDayDelta = metrics.positiveDayRatePercent - baseline.positiveDayRatePercent;
  if (positiveDayDelta >= 10) score += 35;
  else if (positiveDayDelta >= 5) score += 28;
  else if (positiveDayDelta > 0) score += 18;

  if (metrics.netPnl >= baseline.netPnl) score += 20;
  else if (baseline.netPnl >= 0 && metrics.netPnl >= baseline.netPnl * 0.9) score += 10;

  const pf = metrics.profitFactor ?? 999;
  const baselinePf = baseline.profitFactor ?? 999;
  if (pf >= 1 && pf >= baselinePf) score += 15;
  else if (pf >= 1) score += 10;

  if (metrics.maxDrawdownUsd <= baseline.maxDrawdownUsd) score += 20;
  else if (metrics.maxDrawdownUsd <= baseline.maxDrawdownUsd * 1.1) score += 12;
  else if (metrics.maxDrawdownUsd <= baseline.maxDrawdownUsd * 1.2) score += 5;

  if (metrics.worstDayUsd >= baseline.worstDayUsd) score += 10;

  return {
    lane,
    score,
    metrics,
    deltas: {
      positiveDayRatePercent: round(positiveDayDelta, 2),
      netPnl: round(metrics.netPnl - baseline.netPnl, 2),
      profitFactor: metrics.profitFactor !== null && baseline.profitFactor !== null
        ? round(metrics.profitFactor - baseline.profitFactor, 4)
        : null,
      maxDrawdownUsd: round(metrics.maxDrawdownUsd - baseline.maxDrawdownUsd, 2),
      worstDayUsd: round(metrics.worstDayUsd - baseline.worstDayUsd, 2),
    },
  };
}

function classifyLockContribution(
  trendPlusLock: ReturnType<typeof summarizeLane>,
  recoveryPlusLock: ReturnType<typeof summarizeLane>,
): string {
  const netGap = recoveryPlusLock.netPnl - trendPlusLock.netPnl;
  const dayGap = recoveryPlusLock.positiveDayRatePercent - trendPlusLock.positiveDayRatePercent;
  const ddGap = recoveryPlusLock.maxDrawdownUsd - trendPlusLock.maxDrawdownUsd;
  if (Math.abs(netGap) <= 25 && Math.abs(dayGap) <= 5 && Math.abs(ddGap) <= 50) {
    return "LOCK_DOMINANT: Trend+Lock is close to Recovery+Lock; Positive Lock appears to provide most of the observed benefit in this sample.";
  }
  if (netGap > 25 && dayGap > 3 && ddGap <= 50) {
    return "RECOVERY_ADDS_VALUE: Recovery+Lock materially improves economics/day rate beyond Trend+Lock without a large drawdown penalty.";
  }
  if (trendPlusLock.netPnl > recoveryPlusLock.netPnl && trendPlusLock.maxDrawdownUsd <= recoveryPlusLock.maxDrawdownUsd) {
    return "LOCK_ONLY_STRONGER: Trend+Lock is economically stronger than Recovery+Lock in this sample; Recovery may be unnecessary or harmful.";
  }
  return "MIXED: Lock clearly changes trade selection, but the incremental value of Recovery is not yet stable enough to classify.";
}

function detectPattern(bars: Bar[], index: number): { side: Side; pattern: Pattern; patternExtreme: number } | null {
  const current = bars[index]!;
  const previous = bars[index - 1]!;
  if (
    isBearish(previous) && isBullish(current) &&
    current.open <= previous.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 &&
    current.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.open
  ) return { side: "BUY", pattern: "ENGULFING", patternExtreme: current.low };
  if (
    isBullish(previous) && isBearish(current) &&
    current.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.close &&
    current.close <= previous.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9
  ) return { side: "SELL", pattern: "ENGULFING", patternExtreme: current.high };
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

function trendMatches(side: Side, close: number, ma20: number, ma50: number, ma200: number): boolean {
  return side === "BUY"
    ? ma20 > ma50 && ma50 > ma200 && close > ma20
    : ma20 < ma50 && ma50 < ma200 && close < ma20;
}

function findTrendExit(signal: Signal, m15: Bar[], closeTimes: number[], ma20: Array<number | null>) {
  const start = lowerBound(closeTimes, signal.signalTimestamp);
  for (let index = start + 1; index < m15.length; index += 1) {
    const bar = m15[index]!;
    const average = ma20[index];
    if (!Number.isFinite(average)) continue;
    const broken = signal.side === "BUY" ? bar.close < average! : bar.close > average!;
    if (broken) return { timestamp: bar.closeTime, price: closePriceForSide(signal.side, bar.close, bar.spread) };
  }
  return null;
}

function hasRelevantFvg(bars: Bar[], index: number, side: Side, lookback: number): boolean {
  if (index < 2) return false;
  const current = bars[index]!;
  const start = Math.max(2, index - lookback);
  for (let cursor = index - 1; cursor >= start; cursor -= 1) {
    const first = bars[cursor - 2]!;
    const third = bars[cursor]!;
    if (side === "BUY" && third.low > first.high && current.low <= third.low && current.high >= first.high) return true;
    if (side === "SELL" && third.high < first.low && current.high >= third.high && current.low <= first.low) return true;
  }
  return false;
}

function opposingFvgRejectionAt(side: Side, bars: Bar[], currentIndex: number, lookback: number): boolean {
  const current = bars[currentIndex]!;
  const rejectionDirection = side === "BUY" ? isBearish(current) : isBullish(current);
  if (!rejectionDirection) return false;
  const start = Math.max(2, currentIndex - lookback);
  for (let index = currentIndex - 1; index >= start; index -= 1) {
    const first = bars[index - 2]!;
    const third = bars[index]!;
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

function buildConfirmedSwings(bars: Bar[], side: Side): Array<{ confirmedAt: number; level: number }> {
  const result: Array<{ confirmedAt: number; level: number }> = [];
  for (let index = 1; index < bars.length - 1; index += 1) {
    const left = bars[index - 1]!;
    const middle = bars[index]!;
    const right = bars[index + 1]!;
    if (side === "BUY" && middle.low < left.low && middle.low <= right.low) result.push({ confirmedAt: right.closeTime, level: middle.low });
    if (side === "SELL" && middle.high > left.high && middle.high >= right.high) result.push({ confirmedAt: right.closeTime, level: middle.high });
  }
  return result;
}

function latestConfirmedStructure(
  side: Side,
  afterTimestamp: number,
  atOrBefore: number,
  swingLows: Array<{ confirmedAt: number; level: number }>,
  swingHighs: Array<{ confirmedAt: number; level: number }>,
): number | null {
  const swings = side === "BUY" ? swingLows : swingHighs;
  const index = upperBound(swings.map((item) => item.confirmedAt), atOrBefore) - 1;
  if (index < 0) return null;
  const item = swings[index]!;
  return item.confirmedAt > afterTimestamp ? item.level : null;
}

function partialCloseVolume(initial: number, remaining: number, spec: Spec): number {
  const raw = initial / 3;
  const stepped = floorToStep(raw, spec.volumeStep);
  if (stepped < spec.minVolume - 1e-9) return 0;
  if (remaining - stepped < spec.minVolume - 1e-9) return 0;
  return Math.min(stepped, remaining);
}

function targetTouched(side: Side, entry: number, move: number, bar: Bar): boolean {
  return side === "BUY"
    ? bar.high >= entry + move - 1e-9
    : bar.low + bar.spread <= entry - move + 1e-9;
}

function favorableMove(side: Side, entry: number, bar: Bar): number {
  return side === "BUY" ? bar.high - entry : entry - (bar.low + bar.spread);
}

function stopTouched(side: Side, bar: Bar, stop: number): boolean {
  return side === "BUY" ? bar.low <= stop + 1e-9 : bar.high + bar.spread >= stop - 1e-9;
}

function closePriceForSide(side: Side, bidPrice: number, spread: number): number {
  return side === "BUY" ? bidPrice : bidPrice + spread;
}

function improveStop(side: Side, current: number, candidate: number): number {
  return side === "BUY" ? Math.max(current, candidate) : Math.min(current, candidate);
}

function pnlAbs(priceMove: number, volume: number, spec: Spec): number {
  const cash = spec.cashPerPriceUnitPerLot > 0
    ? spec.cashPerPriceUnitPerLot
    : spec.tickSize > 0 ? spec.effectiveTickValuePerLot / spec.tickSize : 0;
  return Math.abs(priceMove) * cash * volume;
}

function pnlUsdSpec(side: Side, entry: number, exit: number, volume: number, spec: Spec): number {
  const move = side === "BUY" ? exit - entry : entry - exit;
  const cash = spec.cashPerPriceUnitPerLot > 0
    ? spec.cashPerPriceUnitPerLot
    : spec.tickSize > 0 ? spec.effectiveTickValuePerLot / spec.tickSize : 0;
  return move * cash * volume;
}

function pnlUsdCash(side: Side, entry: number, exit: number, volume: number, cash: number): number {
  const move = side === "BUY" ? exit - entry : entry - exit;
  return move * cash * volume;
}

function validateFixedVolume(volume: number, spec: Spec): void {
  if (volume < spec.minVolume - 1e-9 || volume > spec.maxVolume + 1e-9) {
    throw new Error(`fixedVolume ${volume} is outside broker range ${spec.minVolume}-${spec.maxVolume}.`);
  }
  const stepped = Math.round(volume / spec.volumeStep) * spec.volumeStep;
  if (Math.abs(stepped - volume) > spec.volumeStep / 100) {
    throw new Error(`fixedVolume ${volume} is not aligned to broker volumeStep ${spec.volumeStep}.`);
  }
}

function rollingSma(values: number[], period: number): Array<number | null> {
  const output: Array<number | null> = Array(values.length).fill(null);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index]!;
    if (index >= period) sum -= values[index - period]!;
    if (index >= period - 1) output[index] = sum / period;
  }
  return output;
}

function dayKey(timestamp: number, utcOffsetHours: number): string {
  return new Date(timestamp + utcOffsetHours * 3_600_000).toISOString().slice(0, 10);
}

function maxConsecutiveLosingDays(values: number[]): number {
  let current = 0;
  let best = 0;
  for (const value of values) {
    if (value < 0) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }
  return best;
}

function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function isBullish(bar: Bar): boolean { return bar.close > bar.open; }
function isBearish(bar: Bar): boolean { return bar.close < bar.open; }
function bodySize(bar: Bar): number { return Math.abs(bar.close - bar.open); }
function finite(value: number | undefined, fallback: number): number { return Number.isFinite(value) ? Number(value) : fallback; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function avg(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
function floorToStep(value: number, step: number): number { return step > 0 ? Math.floor((value + 1e-12) / step) * step : value; }
function normalizeVolume(value: number, step: number): number { return round(Math.max(0, Math.round(value / step) * step), 8); }
