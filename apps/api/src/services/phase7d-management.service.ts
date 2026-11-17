export type Phase7DManagementRequest = {
  from: string;
  to: string;
  fixedVolume?: number;
};

type Side = "BUY" | "SELL";
type Pattern = "ENGULFING" | "TWO_CANDLE_BODY_DOMINANCE";
type ExitReason = "STOP" | "TREND_MA20" | "REVERSAL_FVG_REJECTION" | "END_OF_DATA";
type VariantName = "CURRENT_BE6_PARTIAL_THIRD" | "BE10_PARTIAL_THIRD" | "BE10_PARTIAL_HALF_THEORETICAL";

type Bar = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
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
  patternExtreme: number;
  stopDistance: number;
};

type ManagementConfig = {
  name: VariantName;
  beTrigger: number;
  partialTrigger: number;
  partialFraction: number;
  theoreticalFractionalVolume: boolean;
};

type Trade = Signal & {
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
  plus6Reached: boolean;
  plus10Reached: boolean;
  breakEvenApplied: boolean;
  breakEvenStopExit: boolean;
  beStopBeforePlus10: boolean;
  plus6ThenFullStopBefore10: boolean;
  partialApplied: boolean;
  partialVolume: number;
  partialPnl: number;
  remainingVolumeAtExit: number;
  structuralTrailUpdates: number;
  exitReason: ExitReason;
};

const DAY_MS = 86_400_000;
const ENGULF_BODY_TOLERANCE_PRICE = 0.1;
const M15_MIN_HISTORY = 200;
const MIN_STOP = 6;
const MAX_STOP = 10;
const FVG_LOOKBACK = 12;
const REVERSAL_FVG_LOOKBACK = 48;
const ENTRY_EXPIRY_MS = 15 * 60_000;
const MAX_RESEARCH_DAYS = 370;

function bridgeBase(): string {
  return (process.env.MT5_BRIDGE_BASE_URL ?? "http://127.0.0.1:8765").trim().replace(/\/$/, "");
}

function bridgeApiKey(): string {
  const value = process.env.MT5_BRIDGE_API_KEY?.trim() ?? "";
  if (!value) throw new Error("MT5_BRIDGE_API_KEY is not configured for Phase 7D management research.");
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

export async function runPhase7DManagementResearch(input: Phase7DManagementRequest) {
  const fixedVolume = finite(input.fixedVolume, 0.03);
  if (!(fixedVolume > 0)) throw new Error("fixedVolume must be positive.");

  const fromMs = Date.parse(input.from);
  const toStartMs = Date.parse(input.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toStartMs)) throw new Error("Invalid from/to date.");
  const toMs = toStartMs + DAY_MS;
  if (fromMs >= toMs) throw new Error("from must be before to.");
  const days = Math.ceil((toMs - fromMs) / DAY_MS);
  if (days > MAX_RESEARCH_DAYS) throw new Error(`Management research supports up to ${MAX_RESEARCH_DAYS} days.`);

  const warmupFromMs = fromMs - 45 * DAY_MS;
  const [health, spec, m15, m5] = await Promise.all([
    bridgeGet<BridgeHealth>("/health", 20_000),
    bridgeGet<Spec>("/v1/symbols/XAUUSD/spec", 20_000),
    bridgeGet<Bar[]>(`/v1/history/candles/XAUUSD?timeframe=M15&fromMs=${warmupFromMs}&toMs=${toMs}`, 60_000),
    bridgeGet<Bar[]>(`/v1/history/candles/XAUUSD?timeframe=M5&fromMs=${fromMs}&toMs=${toMs}`, 90_000),
  ]);

  if (!health.connected || health.accountMode !== "demo") {
    throw new Error("Phase 7D management research requires a connected DEMO terminal.");
  }
  validateFixedVolume(fixedVolume, spec);
  if (m15.length <= M15_MIN_HISTORY) throw new Error(`Insufficient M15 history (${m15.length} bars).`);
  if (!m5.length) throw new Error("No M5 history returned for selected range.");

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
      patternExtreme: trigger.patternExtreme,
      stopDistance: clamp(structuralStopDistance, MIN_STOP, MAX_STOP),
    });
  }

  const configs: ManagementConfig[] = [
    { name: "CURRENT_BE6_PARTIAL_THIRD", beTrigger: 6, partialTrigger: 10, partialFraction: 1 / 3, theoreticalFractionalVolume: false },
    { name: "BE10_PARTIAL_THIRD", beTrigger: 10, partialTrigger: 10, partialFraction: 1 / 3, theoreticalFractionalVolume: false },
    { name: "BE10_PARTIAL_HALF_THEORETICAL", beTrigger: 10, partialTrigger: 10, partialFraction: 1 / 2, theoreticalFractionalVolume: true },
  ];

  const variants = configs.map((config) => {
    const raw = signals
      .map((signal) => simulateTrade(signal, config, sortedM15, sortedM5, m5OpenTimes, closeTimes, ma20, spec, fixedVolume, swingLows, swingHighs))
      .filter((trade): trade is Trade => trade !== null)
      .sort((left, right) => left.signalTimestamp - right.signalTimestamp);
    const scheduled = applyMaxOneContention(raw);
    const executable = config.theoreticalFractionalVolume
      ? isVolumeExecutable(fixedVolume * config.partialFraction, fixedVolume, spec)
      : isVolumeExecutable(executablePartialVolume(fixedVolume, config.partialFraction, spec), fixedVolume, spec);
    return {
      name: config.name,
      config: {
        beTrigger: config.beTrigger,
        partialTrigger: config.partialTrigger,
        partialFraction: round(config.partialFraction, 4),
        partialVolumeAtFixedLot: round(
          config.theoreticalFractionalVolume
            ? fixedVolume * config.partialFraction
            : executablePartialVolume(fixedVolume, config.partialFraction, spec),
          4,
        ),
        runnerVolumeAtFixedLot: round(
          fixedVolume - (config.theoreticalFractionalVolume
            ? fixedVolume * config.partialFraction
            : executablePartialVolume(fixedVolume, config.partialFraction, spec)),
          4,
        ),
        executableWithBrokerStep: executable,
        theoreticalOnly: config.theoreticalFractionalVolume && !executable,
      },
      metrics: summarize(scheduled.trades, scheduled.skippedWhileOpen),
      trades: scheduled.trades.slice(-300).reverse(),
    };
  });

  const current = variants.find((item) => item.name === "CURRENT_BE6_PARTIAL_THIRD")!;
  const delayedThird = variants.find((item) => item.name === "BE10_PARTIAL_THIRD")!;
  const theoreticalHalf = variants.find((item) => item.name === "BE10_PARTIAL_HALF_THEORETICAL")!;
  const decision = evaluate(current.metrics, delayedThird.metrics, theoreticalHalf.metrics);

  return {
    source: "PHASE7D_BE_PARTIAL_MANAGEMENT_RESEARCH",
    replayMode: "EXACT_PER_VARIANT_SIGNAL_CONTENTION_WITH_M5_APPROXIMATION",
    generatedAt: Date.now(),
    safety: {
      researchOnly: true,
      executionMutation: false,
      phase7bStrategyMutation: false,
      liveUnlockAvailable: false,
    },
    range: { from: input.from, to: input.to, days },
    broker: {
      accountLogin: health.accountLogin,
      server: health.server,
      symbol: spec.brokerSymbol,
      fixedVolume,
      minVolume: spec.minVolume,
      volumeStep: spec.volumeStep,
    },
    signals: signals.length,
    variants,
    decision,
    notes: [
      "CURRENT is +6 to Entry, +10 close one-third, then canonical runner management.",
      "BE10_PARTIAL_THIRD keeps the original SL until +10; at +10 it moves SL to Entry and closes one-third in the same management step.",
      "STOP_FIRST is used inside an M5 bar. If the old stop and +10 are both contained in the same bar, the stop is assumed to occur first.",
      "plus6ThenFullStopBefore10 measures the main cost of delayed BE: trades that had reached +6, never reached +10, then later hit the original SL.",
      "beStopBeforePlus10 measures the main cost of current BE6: trades protected at Entry after +6 but stopped before ever reaching +10.",
      "Exact half of 0.03 is 0.015 lot, which is not aligned to DBGMarkets 0.01 volume step; the half lane is theoretical unless the configured lot makes both partial and runner executable.",
      "Commission, swap and tick-level slippage are not reconstructed. Research only; Phase 7B DEMO is unchanged.",
    ],
  };
}

function simulateTrade(
  signal: Signal,
  config: ManagementConfig,
  m15: Bar[],
  m5: Bar[],
  m5OpenTimes: number[],
  closeTimes: number[],
  ma20: Array<number | null>,
  spec: Spec,
  volume: number,
  swingLows: Array<{ confirmedAt: number; level: number }>,
  swingHighs: Array<{ confirmedAt: number; level: number }>,
): Trade | null {
  const startIndex = lowerBound(m5OpenTimes, signal.signalTimestamp);
  const first = m5[startIndex];
  if (!first || first.openTime > signal.signalTimestamp + ENTRY_EXPIRY_MS) return null;

  const entry = signal.side === "BUY" ? first.open + first.spread : first.open;
  const stopLoss = signal.side === "BUY" ? entry - signal.stopDistance : entry + signal.stopDistance;
  const initialRiskUsd = pnlAbs(signal.stopDistance, volume, spec);
  let activeStop = stopLoss;
  let remainingVolume = volume;
  let plus6Reached = false;
  let plus10Reached = false;
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
      return closeTrade(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, bar.closeTime, activeStop,
        remainingVolume, plus6Reached, plus10Reached, breakEvenApplied, partialApplied, partialVolume, partialPnl,
        structuralTrailUpdates, "STOP", spec);
    }

    const favorable = favorableMove(signal.side, entry, bar);
    if (favorable >= 6) plus6Reached = true;
    if (favorable >= 10) plus10Reached = true;

    if (!breakEvenApplied && favorable >= config.beTrigger) {
      activeStop = improveStop(signal.side, activeStop, entry);
      breakEvenApplied = true;
    }

    if (!partialApplied && favorable >= config.partialTrigger) {
      const closeVolume = config.theoreticalFractionalVolume
        ? volume * config.partialFraction
        : executablePartialVolume(volume, config.partialFraction, spec);
      if (closeVolume > 0 && remainingVolume - closeVolume > 0) {
        const triggerPrice = signal.side === "BUY" ? entry + config.partialTrigger : entry - config.partialTrigger;
        partialApplied = true;
        partialVolume = closeVolume;
        partialPnl = pnlUsd(signal.side, entry, triggerPrice, closeVolume, spec);
        remainingVolume = config.theoreticalFractionalVolume
          ? remainingVolume - closeVolume
          : normalizeVolume(remainingVolume - closeVolume, spec.volumeStep);
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
            return closeTrade(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, currentM15.closeTime, exit,
              remainingVolume, plus6Reached, plus10Reached, breakEvenApplied, partialApplied, partialVolume, partialPnl,
              structuralTrailUpdates, "REVERSAL_FVG_REJECTION", spec);
          }
        }
      }
    }

    if (trendExit !== null && bar.closeTime >= trendExit.timestamp) {
      return closeTrade(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, trendExit.timestamp, trendExit.price,
        remainingVolume, plus6Reached, plus10Reached, breakEvenApplied, partialApplied, partialVolume, partialPnl,
        structuralTrailUpdates, "TREND_MA20", spec);
    }
  }

  const last = m5.at(-1)!;
  const exit = closePriceForSide(signal.side, last.close, last.spread);
  return closeTrade(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, last.closeTime, exit,
    remainingVolume, plus6Reached, plus10Reached, breakEvenApplied, partialApplied, partialVolume, partialPnl,
    structuralTrailUpdates, "END_OF_DATA", spec);
}

function closeTrade(
  signal: Signal,
  entryTime: number,
  entry: number,
  stopLoss: number,
  initialRiskUsd: number,
  volume: number,
  exitTime: number,
  exit: number,
  remainingVolume: number,
  plus6Reached: boolean,
  plus10Reached: boolean,
  breakEvenApplied: boolean,
  partialApplied: boolean,
  partialVolume: number,
  partialPnl: number,
  structuralTrailUpdates: number,
  exitReason: ExitReason,
  spec: Spec,
): Trade {
  const remainingPnl = pnlUsd(signal.side, entry, exit, remainingVolume, spec);
  const pnl = partialPnl + remainingPnl;
  const breakEvenStopExit = exitReason === "STOP" && breakEvenApplied && Math.abs(exit - entry) <= spec.tickSize + 1e-9;
  const initialStopExit = exitReason === "STOP" && Math.abs(exit - stopLoss) <= spec.tickSize + 1e-9;
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
    plus6Reached,
    plus10Reached,
    breakEvenApplied,
    breakEvenStopExit,
    beStopBeforePlus10: breakEvenStopExit && !plus10Reached,
    plus6ThenFullStopBefore10: plus6Reached && !plus10Reached && initialStopExit,
    partialApplied,
    partialVolume: round(partialVolume, 4),
    partialPnl: round(partialPnl, 2),
    remainingVolumeAtExit: round(remainingVolume, 4),
    structuralTrailUpdates,
    exitReason,
  };
}

function applyMaxOneContention(rawTrades: Trade[]) {
  const trades: Trade[] = [];
  let busyUntil = -Infinity;
  let skippedWhileOpen = 0;
  for (const trade of rawTrades) {
    if (trade.signalTimestamp < busyUntil) {
      skippedWhileOpen += 1;
      continue;
    }
    trades.push(trade);
    busyUntil = trade.exitTime;
  }
  return { trades, skippedWhileOpen };
}

function summarize(trades: Trade[], skippedWhileOpen: number) {
  const wins = trades.filter((trade) => trade.pnl > 0).length;
  const grossProfit = trades.reduce((sum, trade) => sum + Math.max(0, trade.pnl), 0);
  const grossLoss = Math.abs(trades.reduce((sum, trade) => sum + Math.min(0, trade.pnl), 0));
  const netPnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdownUsd = 0;
  for (const trade of [...trades].sort((left, right) => left.exitTime - right.exitTime)) {
    equity += trade.pnl;
    peak = Math.max(peak, equity);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - equity);
  }
  const plus6Reached = trades.filter((trade) => trade.plus6Reached).length;
  const plus10Reached = trades.filter((trade) => trade.plus10Reached).length;
  const beStops = trades.filter((trade) => trade.breakEvenStopExit).length;
  const beBefore10 = trades.filter((trade) => trade.beStopBeforePlus10).length;
  const plus6ThenFullStopBefore10 = trades.filter((trade) => trade.plus6ThenFullStopBefore10).length;
  return {
    trades: trades.length,
    skippedWhileOpen,
    winRatePercent: round(trades.length ? wins / trades.length * 100 : 0, 2),
    netPnl: round(netPnl, 2),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : grossProfit > 0 ? null : 0,
    expectancy: round(trades.length ? netPnl / trades.length : 0, 4),
    averageR: round(avg(trades.map((trade) => trade.rMultiple)), 4),
    maxDrawdownUsd: round(maxDrawdownUsd, 2),
    averageHoldHours: round(avg(trades.map((trade) => trade.holdHours)), 4),
    plus6Reached,
    plus6RatePercent: round(trades.length ? plus6Reached / trades.length * 100 : 0, 2),
    plus10Reached,
    plus10RatePercent: round(trades.length ? plus10Reached / trades.length * 100 : 0, 2),
    breakEvenStopExits: beStops,
    beStopBeforePlus10: beBefore10,
    beStopBeforePlus10RatePercent: round(trades.length ? beBefore10 / trades.length * 100 : 0, 2),
    plus6ThenFullStopBefore10,
    plus6ThenFullStopBefore10RatePercent: round(trades.length ? plus6ThenFullStopBefore10 / trades.length * 100 : 0, 2),
    partialApplied: trades.filter((trade) => trade.partialApplied).length,
    averagePartialPnlUsd: round(avg(trades.filter((trade) => trade.partialApplied).map((trade) => trade.partialPnl)), 2),
  };
}

function evaluate(current: ReturnType<typeof summarize>, delayed: ReturnType<typeof summarize>, half: ReturnType<typeof summarize>) {
  const delta = {
    trades: delayed.trades - current.trades,
    winRatePercent: round(delayed.winRatePercent - current.winRatePercent, 2),
    netPnl: round(delayed.netPnl - current.netPnl, 2),
    profitFactor: delayed.profitFactor !== null && current.profitFactor !== null
      ? round(delayed.profitFactor - current.profitFactor, 4)
      : null,
    expectancy: round(delayed.expectancy - current.expectancy, 4),
    maxDrawdownUsd: round(delayed.maxDrawdownUsd - current.maxDrawdownUsd, 2),
    plus10RatePercent: round(delayed.plus10RatePercent - current.plus10RatePercent, 2),
    beStopsAvoidedBefore10: current.beStopBeforePlus10 - delayed.beStopBeforePlus10,
    extraFullStopsAfterPlus6: delayed.plus6ThenFullStopBefore10 - current.plus6ThenFullStopBefore10,
  };
  const sufficientSample = Math.min(current.trades, delayed.trades) >= 100;
  const delayedPass =
    delayed.netPnl > current.netPnl &&
    (delayed.profitFactor ?? 999) >= (current.profitFactor ?? 0) &&
    delayed.expectancy > current.expectancy &&
    delayed.maxDrawdownUsd <= current.maxDrawdownUsd * 1.25 + 1e-9;
  return {
    sufficientSample,
    verdict: !sufficientSample
      ? "INSUFFICIENT_SAMPLE"
      : delayedPass
        ? "BE10_THIRD_RESEARCH_PROMISING"
        : delayed.netPnl > current.netPnl
          ? "BE10_THIRD_MIXED"
          : "KEEP_CURRENT_BE6_RESEARCH",
    executionEligible: false,
    preferredExecutableResearchVariant: sufficientSample && delayedPass
      ? "BE10_PARTIAL_THIRD"
      : "CURRENT_BE6_PARTIAL_THIRD",
    deltaBe10ThirdVsCurrent: delta,
    theoreticalHalfNetDeltaVsThird: round(half.netPnl - delayed.netPnl, 2),
    reason: !sufficientSample
      ? "Need at least 100 scheduled trades in both executable lanes."
      : delayedPass
        ? "Delaying BE to +10 with one-third partial improves net/PF/expectancy without increasing drawdown more than 25% in this sample."
        : "Delayed BE does not pass all economics and drawdown guards; keep Phase 7B execution unchanged while research continues.",
  };
}

function detectPattern(bars: Bar[], index: number): { side: Side; pattern: Pattern; patternExtreme: number } | null {
  const current = bars[index]!;
  const previous = bars[index - 1]!;
  if (isBearish(previous) && isBullish(current) && current.open <= previous.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 && current.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.open) {
    return { side: "BUY", pattern: "ENGULFING", patternExtreme: current.low };
  }
  if (isBullish(previous) && isBearish(current) && current.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.close && current.close <= previous.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9) {
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

function opposingFvgRejectionAt(side: Side, bars: Bar[], currentIndex: number, lookback: number): boolean {
  const current = bars[currentIndex]!;
  if (!(side === "BUY" ? isBearish(current) : isBullish(current))) return false;
  const start = Math.max(2, currentIndex - lookback);
  for (let index = currentIndex - 1; index >= start; index -= 1) {
    const first = bars[index - 2]!;
    const third = bars[index]!;
    if (side === "BUY" && third.high < first.low) {
      if (current.high >= third.high && current.low <= first.low && current.close < first.low) return true;
    }
    if (side === "SELL" && third.low > first.high) {
      if (current.high >= third.low && current.low <= first.high && current.close > first.high) return true;
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

function latestConfirmedStructure(side: Side, afterTimestamp: number, atOrBefore: number, swingLows: Array<{ confirmedAt: number; level: number }>, swingHighs: Array<{ confirmedAt: number; level: number }>) {
  const swings = side === "BUY" ? swingLows : swingHighs;
  const index = upperBound(swings.map((item) => item.confirmedAt), atOrBefore) - 1;
  if (index < 0) return null;
  const item = swings[index]!;
  return item.confirmedAt > afterTimestamp ? item.level : null;
}

function executablePartialVolume(initial: number, fraction: number, spec: Spec): number {
  const raw = initial * fraction;
  const stepped = Math.round(raw / spec.volumeStep) * spec.volumeStep;
  if (Math.abs(stepped - raw) > spec.volumeStep / 100) return 0;
  if (stepped < spec.minVolume - 1e-9) return 0;
  if (initial - stepped < spec.minVolume - 1e-9) return 0;
  return stepped;
}

function isVolumeExecutable(partial: number, initial: number, spec: Spec) {
  if (!(partial > 0) || !(initial - partial >= spec.minVolume - 1e-9)) return false;
  const stepped = Math.round(partial / spec.volumeStep) * spec.volumeStep;
  const runner = initial - partial;
  const runnerStepped = Math.round(runner / spec.volumeStep) * spec.volumeStep;
  return Math.abs(stepped - partial) <= spec.volumeStep / 100 && Math.abs(runnerStepped - runner) <= spec.volumeStep / 100;
}

function favorableMove(side: Side, entry: number, bar: Bar) {
  return side === "BUY" ? bar.high - entry : entry - (bar.low + bar.spread);
}
function stopTouched(side: Side, bar: Bar, stop: number) {
  return side === "BUY" ? bar.low <= stop + 1e-9 : bar.high + bar.spread >= stop - 1e-9;
}
function closePriceForSide(side: Side, bid: number, spread: number) { return side === "BUY" ? bid : bid + spread; }
function improveStop(side: Side, current: number, candidate: number) { return side === "BUY" ? Math.max(current, candidate) : Math.min(current, candidate); }
function pnlAbs(move: number, volume: number, spec: Spec) { return Math.abs(move) * cashPerPrice(spec) * volume; }
function pnlUsd(side: Side, entry: number, exit: number, volume: number, spec: Spec) { return (side === "BUY" ? exit - entry : entry - exit) * cashPerPrice(spec) * volume; }
function cashPerPrice(spec: Spec) { return spec.cashPerPriceUnitPerLot > 0 ? spec.cashPerPriceUnitPerLot : spec.tickSize > 0 ? spec.effectiveTickValuePerLot / spec.tickSize : 0; }
function validateFixedVolume(volume: number, spec: Spec) {
  if (volume < spec.minVolume - 1e-9 || volume > spec.maxVolume + 1e-9) throw new Error(`fixedVolume ${volume} outside broker range.`);
  const stepped = Math.round(volume / spec.volumeStep) * spec.volumeStep;
  if (Math.abs(stepped - volume) > spec.volumeStep / 100) throw new Error(`fixedVolume ${volume} is not aligned to volumeStep ${spec.volumeStep}.`);
}
function rollingSma(values: number[], period: number) {
  const output: Array<number | null> = Array(values.length).fill(null);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index]!;
    if (index >= period) sum -= values[index - period]!;
    if (index >= period - 1) output[index] = sum / period;
  }
  return output;
}
function lowerBound(values: number[], target: number) { let low = 0; let high = values.length; while (low < high) { const mid = (low + high) >>> 1; if (values[mid]! < target) low = mid + 1; else high = mid; } return low; }
function upperBound(values: number[], target: number) { let low = 0; let high = values.length; while (low < high) { const mid = (low + high) >>> 1; if (values[mid]! <= target) low = mid + 1; else high = mid; } return low; }
function normalizeVolume(value: number, step: number) { return round(Math.max(0, Math.round(value / step) * step), 8); }
function isBullish(bar: Bar) { return bar.close > bar.open; }
function isBearish(bar: Bar) { return bar.close < bar.open; }
function bodySize(bar: Bar) { return Math.abs(bar.close - bar.open); }
function finite(value: number | undefined, fallback: number) { return Number.isFinite(value) ? Number(value) : fallback; }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
function avg(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function round(value: number, digits: number) { const factor = 10 ** digits; return Math.round((value + Number.EPSILON) * factor) / factor; }
