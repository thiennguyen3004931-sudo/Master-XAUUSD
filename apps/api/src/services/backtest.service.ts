import { BacktestEngine, FixedCommissionPerLotModel, FixedTickSlippageModel, type HistoricalStrategyContext } from "@xauusd/backtest-engine";
import { Timeframe } from "@xauusd/market-data";
import type { StrategyEvaluation, StrategyCandidate, MarketRegimeAssessment } from "@xauusd/strategy-engine";
import { OrderSide, SignalStrength, SignalType, TradeDecision, TradingSession } from "@xauusd/types";
import type { BacktestResultDto, BacktestRunRequestDto } from "../types/backtest";
import { clamp, round } from "../utils/number";
import { parseTimeframe, timeframeMs } from "../utils/timeframe";
import { getCandles } from "./market.service";

export async function runPack10Backtest(input: BacktestRunRequestDto): Promise<BacktestResultDto> {
  validate(input);
  const timeframe = parseTimeframe(input.timeframe);
  const from = Date.parse(input.from);
  const to = Date.parse(input.to);
  const duration = timeframeMs(timeframe);
  const requestedBars = Math.floor((to - from) / duration);
  const bars = clamp(requestedBars, 300, 3_000);
  const candles = await getCandles(input.symbol, timeframe, bars, to, input.spread);

  const engine = new BacktestEngine({
    commissionModel: new FixedCommissionPerLotModel(3.5),
    slippageModel: new FixedTickSlippageModel(input.slippageTicks),
  });

  const result = await engine.run({
    runId: `api-${input.symbol}-${timeframe}-${Date.now()}`,
    candles,
    strategyEvaluator: {
      evaluate: (context) => evaluateHistorical(context, input.riskPercent, timeframe),
    },
    config: {
      initialBalance: input.initialBalance,
      contractSize: 100,
      tickSize: 0.01,
      priceDigits: 2,
      volumeStep: 0.01,
      minVolume: 0.01,
      fallbackSpread: input.spread,
      warmupBars: 80,
      maxConcurrentPositions: 1,
      entryFillMode: "NEXT_BAR_OPEN",
      intrabarPriority: input.intrabarPriority,
      forceCloseAtEnd: true,
    },
  });

  return {
    runId: result.runId,
    source: "PACK10",
    generatedAt: Date.now(),
    metrics: {
      netReturnPercent: result.metrics.netReturnPercent,
      netProfit: result.metrics.netProfit,
      totalTrades: result.metrics.totalTrades,
      winRatePercent: result.metrics.winRatePercent,
      profitFactor: Number.isFinite(result.metrics.profitFactor) ? result.metrics.profitFactor : 0,
      expectancy: result.metrics.expectancy,
      maxDrawdownPercent: result.metrics.maxDrawdownPercent,
      sharpeRatio: result.metrics.sharpeRatio,
      averageRMultiple: result.metrics.averageRMultiple,
    },
    equityCurve: result.equityCurve,
    drawdownCurve: result.drawdownCurve.map((point) => ({ timestamp: point.timestamp, drawdownPercent: point.drawdownPercent })),
    warnings: [
      "Pack 10 chạy trên synthetic historical candles từ MockProvider để kiểm thử integration.",
      "Không dùng kết quả này để đánh giá lợi nhuận thực tế trước khi nạp dữ liệu broker lịch sử.",
    ],
  };
}

function evaluateHistorical(
  context: HistoricalStrategyContext,
  riskPercent: number,
  timeframe: Timeframe,
): StrategyEvaluation {
  const now = context.currentCandle.closeTime;
  if (context.currentIndex < 80 || context.openPositions.length > 0 || context.currentIndex % 18 !== 0) {
    return waitEvaluation(now);
  }

  const recent = context.candles.slice(-30);
  const fast = recent.slice(-10).reduce((sum, candle) => sum + candle.close, 0) / 10;
  const slow = recent.reduce((sum, candle) => sum + candle.close, 0) / recent.length;
  const side = fast >= slow ? OrderSide.BUY : OrderSide.SELL;
  const direction = side === OrderSide.BUY ? SignalType.BUY : SignalType.SELL;
  const decision = side === OrderSide.BUY ? TradeDecision.BUY : TradeDecision.SELL;
  const entry = context.currentCandle.close;
  const averageRange = recent.reduce((sum, candle) => sum + (candle.high - candle.low), 0) / recent.length;
  const stopDistance = Math.max(2.5, averageRange * 1.4);
  const stopLoss = side === OrderSide.BUY ? entry - stopDistance : entry + stopDistance;
  const takeProfit = side === OrderSide.BUY ? entry + stopDistance * 2.1 : entry - stopDistance * 2.1;
  const riskAmount = context.balance * (riskPercent / 100);
  const volume = Math.max(0.01, Math.floor((riskAmount / (stopDistance * 100)) / 0.01) * 0.01);
  const candidate = createCandidate(direction);
  const regime = createRegime();

  return {
    action: "EXECUTE",
    plan: {
      order: {
        symbol: context.currentCandle.symbol,
        side,
        volume: round(Math.min(volume, 2), 2),
        entry: round(entry),
        stopLoss: round(stopLoss),
        takeProfit: round(takeProfit),
        clientOrderId: `bt-${context.currentIndex}-${now}`,
        comment: "Pack10 API integration evaluator",
      },
      selectedStrategy: candidate,
      regime,
      session: TradingSession.LONDON,
      management: {
        partialTargets: [
          { label: "TP1", price: round(side === OrderSide.BUY ? entry + stopDistance : entry - stopDistance), closePercent: 30, rewardMultiple: 1 },
          { label: "TP2", price: round(side === OrderSide.BUY ? entry + stopDistance * 1.5 : entry - stopDistance * 1.5), closePercent: 30, rewardMultiple: 1.5 },
          { label: "TP3", price: round(takeProfit), closePercent: 40, rewardMultiple: 2.1 },
        ],
        moveStopToBreakEvenAtR: 1,
        trailingStop: { enabled: true, startAtR: 1.5, mode: "ATR", atrMultiple: 1, neverWidenStop: true },
        maximumHoldingMinutes: 8 * 60,
        cancelIfNotFilledAfterMinutes: 60,
        hardInvalidationPrice: round(side === OrderSide.BUY ? stopLoss - stopDistance : stopLoss + stopDistance),
        timeStopAt: now + 8 * 60 * 60_000,
      },
      expiresAt: now + Math.max(timeframeMs(timeframe) * 4, 60 * 60_000),
      generatedAt: now,
    },
    regime,
    botMode: "TREND",
    recommendedBotMode: "TREND",
    selection: { selected: candidate, runnerUp: null, edge: 20, ranked: [candidate] },
    rules: [],
    diagnostics: { accepted: true, rejectionCodes: [], warnings: [], notes: ["Deterministic API backtest evaluator."] },
    commonResult: {
      decision,
      signal: {
        symbol: context.currentCandle.symbol,
        timeframe: String(timeframe),
        type: direction,
        strength: SignalStrength.STRONG,
        confidence: 80,
        entry: round(entry),
        stopLoss: round(stopLoss),
        takeProfit: round(takeProfit),
        reasons: ["Fast/slow historical trend filter."],
        createdAt: now,
      },
      confidence: 80,
      reasons: ["Pack10 deterministic trend continuation evaluator."],
      createdAt: now,
    },
    generatedAt: now,
  };
}

function waitEvaluation(now: number): StrategyEvaluation {
  const regime = createRegime();
  return {
    action: "WAIT",
    plan: null,
    regime,
    botMode: "TREND",
    recommendedBotMode: "TREND",
    selection: { selected: null, runnerUp: null, edge: 0, ranked: [] },
    rules: [],
    diagnostics: { accepted: false, rejectionCodes: ["NO_ELIGIBLE_STRATEGY"], warnings: [], notes: ["Waiting for scheduled historical evaluation window."] },
    commonResult: { decision: TradeDecision.WAIT, signal: null, confidence: 0, reasons: ["WAIT"], createdAt: now },
    generatedAt: now,
  };
}

function createCandidate(direction: SignalType): StrategyCandidate {
  return {
    strategyId: "TREND_CONTINUATION",
    name: "API Backtest Trend Continuation",
    eligible: true,
    direction,
    score: 80,
    rawScore: 80,
    scoreBreakdown: { signal: 16, structure: 12, regime: 14, momentum: 12, location: 8, multiTimeframe: 8, session: 10, total: 80 },
    supportedRegimes: ["TRENDING"],
    supportedSessions: [TradingSession.ASIAN, TradingSession.LONDON, TradingSession.NEW_YORK, TradingSession.OVERLAP],
    reasons: ["Deterministic trend filter for Pack10 integration."],
    invalidations: ["Stop loss reached."],
    warnings: [],
  };
}

function createRegime(): MarketRegimeAssessment {
  return {
    regime: "TRENDING",
    confidence: 75,
    reasons: ["Historical evaluator trend regime."],
    metrics: { adx: 25, bollingerBandwidth: null, volatilityPercent: 1, confirmedBosCount: 0, confirmedChochCount: 0 },
  };
}

function validate(input: BacktestRunRequestDto): void {
  if (!input.symbol.trim()) throw new Error("symbol is required.");
  if (!Number.isFinite(input.initialBalance) || input.initialBalance <= 0) throw new Error("initialBalance must be positive.");
  if (!Number.isFinite(input.riskPercent) || input.riskPercent <= 0 || input.riskPercent > 5) throw new Error("riskPercent must be > 0 and <= 5.");
  if (!Number.isFinite(input.spread) || input.spread < 0) throw new Error("spread must be non-negative.");
  if (!Number.isInteger(input.slippageTicks) || input.slippageTicks < 0) throw new Error("slippageTicks must be a non-negative integer.");
  const from = Date.parse(input.from); const to = Date.parse(input.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error("Invalid from/to dates.");
}
