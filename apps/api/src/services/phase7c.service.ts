type Side = "BUY" | "SELL";
type Pattern = "ENGULFING" | "TWO_CANDLE_BODY_DOMINANCE";
type ExitReason = "STOP" | "TREND_MA20" | "REVERSAL_FVG_REJECTION" | "END_OF_DATA";

type Bar = {
  symbol: string;
  brokerSymbol: string;
  timeframe: string;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  spread: number;
};

type BridgeHealth = {
  status: "ok" | "degraded";
  connected: boolean;
  tradingEnabled: boolean;
  terminalTradeAllowed: boolean;
  expertTradeAllowed: boolean;
  accountLogin: number | null;
  accountMode: "demo" | "contest" | "real" | null;
  accountBalance: number | null;
  accountEquity: number | null;
  accountMargin: number | null;
  accountFreeMargin: number | null;
  accountProfit: number | null;
  accountLeverage: number | null;
  accountCurrency: string | null;
  server: string | null;
  terminalVersion: string | null;
  timestamp: number;
};

type Quote = {
  symbol: string;
  brokerSymbol: string;
  bid: number;
  ask: number;
  spread: number;
  timestamp: number;
};

type Spec = {
  symbol: string;
  brokerSymbol: string;
  tickSize: number;
  point: number;
  tickValuePerLot: number;
  effectiveTickValuePerLot: number;
  cashPerPriceUnitPerLot: number;
  riskValueSource: string;
  tickValueProfitPerLot: number;
  tickValueLossPerLot: number;
  contractSize: number;
  digits: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
  maxSpread: number;
  stopsLevelTicks: number;
  freezeLevelTicks: number;
  fillingMode: number;
  executionMode: number;
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
  breakEvenApplied: boolean;
  partialApplied: boolean;
  partialVolume: number;
  partialPnl: number;
  remainingVolumeAtExit: number;
  structuralTrailUpdates: number;
  exitReason: ExitReason;
};

export type Phase7CBacktestRequest = {
  from: string;
  to: string;
  fixedVolume?: number;
};

const ENGULF_BODY_TOLERANCE_PRICE = 0.1;
const M15_MIN_HISTORY = 200;
const MIN_STOP = 6;
const MAX_STOP = 10;
const BREAK_EVEN_TRIGGER = 6;
const PARTIAL_TRIGGER = 10;
const FVG_LOOKBACK = 12;
const REVERSAL_FVG_LOOKBACK = 48;
const ENTRY_EXPIRY_MS = 15 * 60_000;
const MAX_BACKTEST_DAYS = 370;

function bridgeBase(): string {
  return (process.env.MT5_BRIDGE_BASE_URL ?? "http://127.0.0.1:8765").trim().replace(/\/$/, "");
}

function bridgeApiKey(): string {
  const value = process.env.MT5_BRIDGE_API_KEY?.trim() ?? "";
  if (!value) throw new Error("MT5_BRIDGE_API_KEY is not configured for Phase 7C.");
  return value;
}

async function bridgeGet<T>(path: string, timeoutMs = 15_000): Promise<T> {
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

export async function getPhase7CAccountRisk(riskPercent = 0.25, maxLot = 0.03) {
  if (!Number.isFinite(riskPercent) || riskPercent <= 0 || riskPercent > 5) {
    throw new Error("riskPercent must be > 0 and <= 5.");
  }
  if (!Number.isFinite(maxLot) || maxLot <= 0) throw new Error("maxLot must be positive.");

  const [health, quote, spec] = await Promise.all([
    bridgeGet<BridgeHealth>("/health"),
    bridgeGet<Quote>("/v1/quotes/XAUUSD"),
    bridgeGet<Spec>("/v1/symbols/XAUUSD/spec"),
  ]);
  if (!health.connected) throw new Error("MT5 bridge is disconnected.");
  if (health.accountMode !== "demo") throw new Error(`Phase 7C requires DEMO account, got ${health.accountMode ?? "unknown"}.`);

  const balance = Number(health.accountBalance ?? 0);
  const targetRiskUsd = balance * riskPercent / 100;
  const effectiveMaxLot = Math.min(maxLot, spec.maxVolume);
  const cashPerPriceUnitPerLot = spec.cashPerPriceUnitPerLot > 0
    ? spec.cashPerPriceUnitPerLot
    : spec.tickSize > 0
      ? spec.effectiveTickValuePerLot / spec.tickSize
      : 0;

  const rows = [6, 8, 10].map((stopDistance) => {
    const lossAtSlOneLot = stopDistance * cashPerPriceUnitPerLot;
    const rawLot = lossAtSlOneLot > 0 ? targetRiskUsd / lossAtSlOneLot : 0;
    const cap = Math.min(rawLot, effectiveMaxLot);
    const stepped = floorToStep(cap, spec.volumeStep);
    const recommendedLot = stepped >= spec.minVolume - 1e-9 ? stepped : 0;
    const riskUsd = recommendedLot * lossAtSlOneLot;
    return {
      stopDistance,
      targetRiskUsd: round(targetRiskUsd, 2),
      lossAtSlOneLot: round(lossAtSlOneLot, 2),
      rawLot: round(rawLot, 4),
      recommendedLot: round(recommendedLot, 4),
      estimatedRiskUsd: round(riskUsd, 2),
      estimatedRiskPercent: balance > 0 ? round(riskUsd / balance * 100, 4) : 0,
      approved: recommendedLot >= spec.minVolume - 1e-9,
      reason: recommendedLot >= spec.minVolume - 1e-9
        ? "SHADOW recommendation only; Phase 7B execution remains unchanged."
        : "Broker minimum lot would exceed the configured risk target; block instead of forcing 0.01 lot.",
    };
  });

  return {
    source: "MT5_DEMO_READ_ONLY",
    generatedAt: Date.now(),
    safety: {
      mode: "AUTO_LOT_SHADOW",
      executionMutation: false,
      phase7bFixedVolumeUnchanged: true,
      liveUnlockAvailable: false,
    },
    account: health,
    quote,
    spec,
    configuration: {
      riskPercent,
      maxLot,
      currentFixedVolume: 0.03,
      targetRiskUsd: round(targetRiskUsd, 2),
    },
    rows,
  };
}

export async function runPhase7CCanonicalBacktest(input: Phase7CBacktestRequest) {
  const fromMs = Date.parse(input.from);
  const toStartMs = Date.parse(input.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toStartMs)) throw new Error("Invalid from/to date.");
  const toMs = toStartMs + 24 * 60 * 60_000;
  if (fromMs >= toMs) throw new Error("from must be before to.");
  const days = Math.ceil((toMs - fromMs) / 86_400_000);
  if (days > MAX_BACKTEST_DAYS) throw new Error(`Phase 7C backtest currently supports up to ${MAX_BACKTEST_DAYS} days per run.`);

  const fixedVolume = Number(input.fixedVolume ?? 0.03);
  if (!Number.isFinite(fixedVolume) || fixedVolume <= 0) throw new Error("fixedVolume must be positive.");

  const warmupFromMs = fromMs - 45 * 24 * 60 * 60_000;
  const [health, spec, m15, m5] = await Promise.all([
    bridgeGet<BridgeHealth>("/health", 20_000),
    bridgeGet<Spec>("/v1/symbols/XAUUSD/spec", 20_000),
    bridgeGet<Bar>("/health", 1).catch(() => null),
    Promise.resolve(null),
  ]).then(async ([h, s]) => {
    const m15Bars = await bridgeGet<Bar[]>(`/v1/history/candles/XAUUSD?timeframe=M15&fromMs=${warmupFromMs}&toMs=${toMs}`, 45_000);
    const m5Bars = await bridgeGet<Bar[]>(`/v1/history/candles/XAUUSD?timeframe=M5&fromMs=${fromMs}&toMs=${toMs}`, 60_000);
    return [h, s, m15Bars, m5Bars] as const;
  });

  if (!health.connected || health.accountMode !== "demo") throw new Error("Canonical broker backtest requires a connected DEMO terminal.");
  if (m15.length <= M15_MIN_HISTORY) throw new Error(`Insufficient M15 history (${m15.length} bars).`);
  if (m5.length === 0) throw new Error("No M5 history returned for selected range.");
  validateFixedVolume(fixedVolume, spec);

  const sortedM15 = [...m15].sort((a, b) => a.openTime - b.openTime);
  const sortedM5 = [...m5].sort((a, b) => a.openTime - b.openTime);
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

  const rawTrades = signals
    .map((signal) => simulateTrade(signal, sortedM15, sortedM5, closeTimes, ma20, spec, fixedVolume, swingLows, swingHighs))
    .filter((trade): trade is Trade => trade !== null);
  const trades: Trade[] = [];
  let busyUntil = -Infinity;
  let skippedWhilePositionOpen = 0;
  for (const trade of [...rawTrades].sort((a, b) => a.signalTimestamp - b.signalTimestamp)) {
    if (trade.signalTimestamp < busyUntil) {
      skippedWhilePositionOpen += 1;
      continue;
    }
    trades.push(trade);
    busyUntil = trade.exitTime;
  }

  const tradingDays = new Set(
    sortedM15.filter((bar) => bar.closeTime >= fromMs && bar.closeTime < toMs)
      .map((bar) => new Date(bar.closeTime).toISOString().slice(0, 10)),
  ).size;
  const summary = summarize(trades);
  const buy = summarize(trades.filter((trade) => trade.side === "BUY"));
  const sell = summarize(trades.filter((trade) => trade.side === "SELL"));
  const engulfing = summarize(trades.filter((trade) => trade.pattern === "ENGULFING"));
  const twoCandle = summarize(trades.filter((trade) => trade.pattern === "TWO_CANDLE_BODY_DOMINANCE"));
  const equityCurve: Array<{ timestamp: number; pnl: number; drawdown: number }> = [];
  let cumulative = 0;
  let peak = 0;
  let maxDrawdownUsd = 0;
  for (const trade of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    cumulative += trade.pnl;
    peak = Math.max(peak, cumulative);
    const drawdown = peak - cumulative;
    maxDrawdownUsd = Math.max(maxDrawdownUsd, drawdown);
    equityCurve.push({ timestamp: trade.exitTime, pnl: round(cumulative, 2), drawdown: round(drawdown, 2) });
  }

  const exitReasons = Object.fromEntries(
    ["STOP", "TREND_MA20", "REVERSAL_FVG_REJECTION", "END_OF_DATA"].map((reason) => [
      reason,
      trades.filter((trade) => trade.exitReason === reason).length,
    ]),
  );

  return {
    source: "PHASE7C_MT5_BROKER_HISTORY",
    replayMode: "CLOSED_M15_WITH_M5_EXECUTION_APPROXIMATION",
    productionEquivalent: false,
    generatedAt: Date.now(),
    range: {
      from: input.from,
      to: input.to,
      days,
      tradingDays,
      m15Bars: sortedM15.filter((bar) => bar.closeTime >= fromMs && bar.closeTime < toMs).length,
      m5Bars: sortedM5.length,
    },
    account: {
      login: health.accountLogin,
      mode: health.accountMode,
      server: health.server,
      currency: health.accountCurrency,
    },
    broker: {
      symbol: spec.brokerSymbol,
      tickSize: spec.tickSize,
      cashPerPriceUnitPerLot: spec.cashPerPriceUnitPerLot,
      minVolume: spec.minVolume,
      volumeStep: spec.volumeStep,
      fixedVolume,
    },
    rules: {
      entry: "ENGULFING_TOLERANCE_0.10_OR_TWO_CANDLE_PLUS_MA20_50_200",
      fvgAtEntry: "OPTIONAL",
      initialStop: "STRUCTURAL_CLAMP_6_TO_10_PRICE",
      plus6: "SL_TO_ENTRY",
      plus10: "PARTIAL_ONE_THIRD",
      runner: "CONFIRMED_M15_SWING_ONLY_TIGHTEN",
      reversalExit: "OPPOSING_FVG_PLUS_REJECTION_AFTER_PLUS10",
      fallbackExit: "M15_CLOSE_CROSSES_MA20",
      maxManagedPositions: 1,
      intrabarPriority: "STOP_FIRST",
    },
    metrics: {
      signals: signals.length,
      trades: trades.length,
      skippedWhilePositionOpen,
      tradesPerTradingDay: round(tradingDays > 0 ? trades.length / tradingDays : 0, 4),
      winRatePercent: summary.winRatePercent,
      netPnl: summary.netPnl,
      profitFactor: summary.profitFactor,
      expectancy: summary.expectancy,
      averageR: summary.averageR,
      maxDrawdownUsd: round(maxDrawdownUsd, 2),
      averageHoldHours: round(avg(trades.map((trade) => trade.holdHours)), 4),
      breakEvenApplied: trades.filter((trade) => trade.breakEvenApplied).length,
      partialApplied: trades.filter((trade) => trade.partialApplied).length,
      structuralTrailUpdates: trades.reduce((sum, trade) => sum + trade.structuralTrailUpdates, 0),
      exitReasons,
    },
    breakdown: { buy, sell, engulfing, twoCandle },
    equityCurve,
    trades: trades.slice(-500).reverse(),
    notes: [
      "Broker-native DBGMarkets/MT5 historical OHLC is used; Pack 10 synthetic MockProvider is not used.",
      "This replay evaluates closed M15 signals. It cannot reproduce the live 5-10 second pre-close provisional candle without tick/M1 snapshot reconstruction.",
      "M5 OHLC with broker-reported spread approximates execution; STOP_FIRST is used when one bar can contain conflicting intrabar paths.",
      "Commission, swap and exact tick-level slippage are not reconstructed in this Phase 7C research lane.",
      "Phase 7B DEMO execution settings are not mutated by this endpoint.",
    ],
  };
}

function simulateTrade(
  signal: Signal,
  m15: Bar[],
  m5: Bar[],
  closeTimes: number[],
  ma20: Array<number | null>,
  spec: Spec,
  volume: number,
  swingLows: Array<{ confirmedAt: number; level: number }>,
  swingHighs: Array<{ confirmedAt: number; level: number }>,
): Trade | null {
  const startIndex = lowerBound(m5.map((bar) => bar.openTime), signal.signalTimestamp);
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

  for (let i = startIndex; i < m5.length; i += 1) {
    const bar = m5[i]!;
    if (stopTouched(signal.side, bar, activeStop)) {
      return closeTrade(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, bar.closeTime, activeStop,
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
      const currentM15Index = upperBound(closeTimes, bar.closeTime) - 1;
      if (currentM15Index >= 2) {
        const currentM15 = m15[currentM15Index]!;
        if (currentM15.closeTime > lastReversalM15CloseChecked && currentM15.closeTime > signal.signalTimestamp) {
          lastReversalM15CloseChecked = currentM15.closeTime;
          if (opposingFvgRejectionAt(signal.side, m15, currentM15Index, REVERSAL_FVG_LOOKBACK)) {
            const exit = closePriceForSide(signal.side, currentM15.close, currentM15.spread);
            return closeTrade(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, currentM15.closeTime, exit,
              remainingVolume, breakEvenApplied, partialApplied, partialVolume, partialPnl, structuralTrailUpdates,
              "REVERSAL_FVG_REJECTION", spec);
          }
        }
      }
    }

    if (trendExit !== null && bar.closeTime >= trendExit.timestamp) {
      return closeTrade(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, trendExit.timestamp, trendExit.price,
        remainingVolume, breakEvenApplied, partialApplied, partialVolume, partialPnl, structuralTrailUpdates,
        "TREND_MA20", spec);
    }
  }

  const last = m5.at(-1)!;
  const exit = closePriceForSide(signal.side, last.close, last.spread);
  return closeTrade(signal, first.openTime, entry, stopLoss, initialRiskUsd, volume, last.closeTime, exit,
    remainingVolume, breakEvenApplied, partialApplied, partialVolume, partialPnl, structuralTrailUpdates,
    "END_OF_DATA", spec);
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

function trendMatches(side: Side, close: number, a20: number, a50: number, a200: number): boolean {
  return side === "BUY"
    ? a20 > a50 && a50 > a200 && close > a20
    : a20 < a50 && a50 < a200 && close < a20;
}

function findTrendExit(signal: Signal, m15: Bar[], closeTimes: number[], ma20: Array<number | null>) {
  const start = lowerBound(closeTimes, signal.signalTimestamp);
  for (let i = start + 1; i < m15.length; i += 1) {
    const bar = m15[i]!;
    const average = ma20[i];
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
  for (let i = index - 1; i >= start; i -= 1) {
    const first = bars[i - 2]!;
    const third = bars[i]!;
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
  for (let i = currentIndex - 1; i >= start; i -= 1) {
    const first = bars[i - 2]!;
    const third = bars[i]!;
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
  for (let i = 1; i < bars.length - 1; i += 1) {
    const left = bars[i - 1]!;
    const middle = bars[i]!;
    const right = bars[i + 1]!;
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

function pnlUsd(side: Side, entry: number, exit: number, volume: number, spec: Spec): number {
  const move = side === "BUY" ? exit - entry : entry - exit;
  const cash = spec.cashPerPriceUnitPerLot > 0
    ? spec.cashPerPriceUnitPerLot
    : spec.tickSize > 0 ? spec.effectiveTickValuePerLot / spec.tickSize : 0;
  return move * cash * volume;
}

function summarize(trades: Trade[]) {
  const wins = trades.filter((trade) => trade.pnl > 0).length;
  const grossProfit = trades.reduce((sum, trade) => sum + Math.max(0, trade.pnl), 0);
  const grossLoss = Math.abs(trades.reduce((sum, trade) => sum + Math.min(0, trade.pnl), 0));
  const netPnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  return {
    trades: trades.length,
    winRatePercent: round(trades.length ? wins / trades.length * 100 : 0, 2),
    netPnl: round(netPnl, 2),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : null,
    expectancy: round(trades.length ? netPnl / trades.length : 0, 4),
    averageR: round(avg(trades.map((trade) => trade.rMultiple)), 4),
  };
}

function rollingSma(values: number[], period: number): Array<number | null> {
  const output: Array<number | null> = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) output[i] = sum / period;
  }
  return output;
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

function isBullish(bar: Bar): boolean { return bar.close > bar.open; }
function isBearish(bar: Bar): boolean { return bar.close < bar.open; }
function bodySize(bar: Bar): number { return Math.abs(bar.close - bar.open); }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function avg(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function round(value: number, digits: number): number { const factor = 10 ** digits; return Math.round((value + Number.EPSILON) * factor) / factor; }
function floorToStep(value: number, step: number): number { return step > 0 ? Math.floor((value + 1e-12) / step) * step : value; }
function normalizeVolume(value: number, step: number): number { return round(Math.max(0, Math.round(value / step) * step), 8); }

function lowerBound(values: number[], target: number): number {
  let low = 0; let high = values.length;
  while (low < high) { const mid = (low + high) >>> 1; if (values[mid]! < target) low = mid + 1; else high = mid; }
  return low;
}
function upperBound(values: number[], target: number): number {
  let low = 0; let high = values.length;
  while (low < high) { const mid = (low + high) >>> 1; if (values[mid]! <= target) low = mid + 1; else high = mid; }
  return low;
}
