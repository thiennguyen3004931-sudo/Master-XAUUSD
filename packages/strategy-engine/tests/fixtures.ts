import type { DetailedAnalysisResult } from "@xauusd/analysis-engine";
import type { IndicatorReport } from "@xauusd/indicators";
import { Timeframe } from "@xauusd/market-data";
import type { RiskAssessment } from "@xauusd/risk-engine";
import type { SignalEngineResult } from "@xauusd/signal-engine";
import {
  MarketStructure,
  OrderSide,
  SignalStrength,
  SignalType,
  SwingType,
  TradeDecision,
  TradingSession,
  Trend,
  type StrategyResult,
} from "@xauusd/types";
import type { StrategyContext } from "../src";

export const now = 1_700_000_000_000;

export function createAnalysis(overrides: Partial<DetailedAnalysisResult> = {}): DetailedAnalysisResult {
  const candle = {
    symbol: "XAUUSD",
    timeframe: Timeframe.M15,
    openTime: now - 900_000,
    closeTime: now,
    open: 2398,
    high: 2402,
    low: 2397,
    close: 2400,
    volume: 1500,
  };
  return {
    symbol: "XAUUSD",
    timeframe: Timeframe.M15,
    trend: Trend.Bullish,
    structure: MarketStructure.Bullish,
    lastCandle: candle,
    swings: [{ index: 10, timestamp: now - 1_800_000, price: 2394, high: 2395, low: 2393, close: 2394, type: SwingType.Low, strength: 3 }],
    internalSwings: [],
    externalSwings: [],
    liquidityZones: [{ price: 2395, strength: 3, touched: false }],
    orderBlocks: [{ high: 2398, low: 2394, bullish: true, mitigated: false }],
    fairValueGaps: [{ high: 2399, low: 2397, filled: false }],
    equalHighs: [],
    equalLows: [],
    premiumZone: 2405,
    discountZone: 2395,
    equilibrium: 2400,
    score: 82,
    createdAt: now,
    metrics: {
      averageTrueRange: 4,
      volatilityPercent: 0.8,
      rangeHigh: 2410,
      rangeLow: 2390,
      rangeSize: 20,
      dataQuality: 100,
    },
    structureEvents: [{ id: "bos-1", type: "BOS", direction: Trend.Bullish, level: 2399, candleIndex: 100, timestamp: now - 60_000, confirmed: true }],
    ...overrides,
  };
}

export function createIndicators(overrides: Partial<IndicatorReport> = {}): IndicatorReport {
  return {
    symbol: "XAUUSD",
    timeframe: Timeframe.M15,
    candleCount: 260,
    generatedAt: now,
    config: {
      smaPeriods: [20, 50, 200],
      emaPeriods: [20, 50, 200],
      atrPeriod: 14,
      rsiPeriod: 14,
      macdFastPeriod: 12,
      macdSlowPeriod: 26,
      macdSignalPeriod: 9,
      bollingerPeriod: 20,
      bollingerStandardDeviations: 2,
      stochasticPeriod: 14,
      stochasticSignalPeriod: 3,
      adxPeriod: 14,
      volumeSmaPeriod: 20,
      priceSource: "close",
    },
    series: {
      sma: {}, ema: {}, atr: [], rsi: [], macd: [], bollingerBands: [], stochastic: [], adx: [], vwap: [], volumeSma: [],
    },
    latest: {
      timestamp: now,
      close: 2400,
      sma: { "20": 2397, "50": 2390, "200": 2350 },
      ema: { "20": 2398, "50": 2392, "200": 2360 },
      atr: 4,
      rsi: 58,
      macd: { macd: 2, signal: 1, histogram: 1 },
      bollingerBands: { middle: 2398, upper: 2405, lower: 2391, bandwidth: 0.006, percentB: 0.65 },
      stochastic: { k: 62, d: 58 },
      adx: { adx: 32, plusDI: 28, minusDI: 14 },
      vwap: 2397,
      volumeSma: 1000,
    },
    warmupComplete: true,
    ...overrides,
  };
}

export function createSignalResult(overrides: Partial<SignalEngineResult> = {}): SignalEngineResult {
  const signal = {
    symbol: "XAUUSD",
    timeframe: "M15",
    type: SignalType.BUY,
    strength: SignalStrength.STRONG,
    confidence: 85,
    entry: 2400,
    stopLoss: 2395,
    takeProfit: 2411,
    reasons: ["Bullish continuation"],
    createdAt: now,
  };
  return {
    decision: TradeDecision.BUY,
    signal,
    score: { direction: "BULLISH", bullishPoints: 82, bearishPoints: 18, maximumPoints: 100, confidence: 82, directionalEdge: 64 },
    levels: {
      entry: 2400,
      stopLoss: 2395,
      takeProfit: 2411,
      riskDistance: 5,
      rewardDistance: 11,
      riskReward: 2.2,
      stopSource: "ATR",
      targetSource: "R_MULTIPLE",
      partialTargets: [
        { label: "TP1", price: 2405, closePercent: 30, rewardMultiple: 1 },
        { label: "TP2", price: 2408, closePercent: 30, rewardMultiple: 1.6 },
        { label: "TP3", price: 2411, closePercent: 40, rewardMultiple: 2.2 },
      ],
    },
    rules: [],
    diagnostics: { accepted: true, rejectionCodes: [], notes: [] },
    generatedAt: now,
    ...overrides,
  };
}

export function createRiskAssessment(overrides: Partial<RiskAssessment> = {}): RiskAssessment {
  const order = { symbol: "XAUUSD", side: OrderSide.BUY, volume: 0.2, entry: 2400, stopLoss: 2395, takeProfit: 2411 };
  return {
    approved: true,
    decision: "APPROVE",
    order,
    commonResult: { approved: true, reason: "Approved", riskAmount: 100, riskPercent: 1, positionSize: 0.2, position: order },
    budget: null,
    sizing: null,
    margin: null,
    exposure: null,
    rules: [],
    diagnostics: { accepted: true, rejectionCodes: [], warnings: [], notes: [] },
    generatedAt: now,
    ...overrides,
  };
}

export function createContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    analysis: createAnalysis(),
    indicators: createIndicators(),
    signalResult: createSignalResult(),
    riskAssessment: createRiskAssessment(),
    session: TradingSession.LONDON,
    evaluatedAt: now + 60_000,
    ...overrides,
  };
}

export function acceptsCommonResult(value: StrategyResult): StrategyResult {
  return value;
}
