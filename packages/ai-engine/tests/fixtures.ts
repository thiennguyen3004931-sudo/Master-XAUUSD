import type {
  DetailedAnalysisResult
} from "@xauusd/analysis-engine";
import type {
  PerformanceMetrics
} from "@xauusd/backtest-engine";
import {
  Timeframe
} from "@xauusd/market-data";
import type {
  IndicatorReport
} from "@xauusd/indicators";
import type {
  RiskAssessment
} from "@xauusd/risk-engine";
import type {
  SignalEngineResult
} from "@xauusd/signal-engine";
import type {
  StrategyEvaluation
} from "@xauusd/strategy-engine";
import {
  MarketStructure,
  OrderSide,
  SignalStrength,
  SignalType,
  TradeDecision,
  TradingSession,
  Trend
} from "@xauusd/types";
import type {
  AiContext,
  AiStructuredOpinion
} from "../src";

export const NOW = 1_700_000_000_000;

export function createAnalysis():
  DetailedAnalysisResult {
  return {
    symbol: "XAUUSD",
    timeframe: Timeframe.M15,
    trend: Trend.Bullish,
    structure: MarketStructure.Bullish,
    lastCandle: {
      symbol: "XAUUSD",
      timeframe: Timeframe.M15,
      openTime: NOW - 900_000,
      closeTime: NOW,
      open: 2398,
      high: 2402,
      low: 2397,
      close: 2400,
      volume: 1000
    },
    swings: [],
    internalSwings: [],
    externalSwings: [],
    liquidityZones: [],
    orderBlocks: [],
    fairValueGaps: [],
    equalHighs: [],
    equalLows: [],
    premiumZone: 2410,
    discountZone: 2390,
    equilibrium: 2400,
    score: 88,
    createdAt: NOW,
    metrics: {
      averageTrueRange: 5,
      volatilityPercent: 1.2,
      rangeHigh: 2410,
      rangeLow: 2390,
      rangeSize: 20,
      dataQuality: 95
    },
    structureEvents: []
  };
}

export function createIndicators():
  IndicatorReport {
  const empty = {
    macd: null,
    signal: null,
    histogram: 1.2
  };
  return {
    symbol: "XAUUSD",
    timeframe: Timeframe.M15,
    candleCount: 300,
    generatedAt: NOW,
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
      priceSource: "close"
    },
    series: {
      sma: {},
      ema: {},
      atr: [],
      rsi: [],
      macd: [],
      bollingerBands: [],
      stochastic: [],
      adx: [],
      vwap: [],
      volumeSma: []
    },
    latest: {
      timestamp: NOW,
      close: 2400,
      sma: {},
      ema: {},
      atr: 5,
      rsi: 58,
      macd: empty,
      bollingerBands: {
        middle: null,
        upper: null,
        lower: null,
        bandwidth: null,
        percentB: null
      },
      stochastic: {
        k: 62,
        d: 58
      },
      adx: {
        adx: 28,
        plusDI: 31,
        minusDI: 18
      },
      vwap: 2399,
      volumeSma: 900
    },
    warmupComplete: true
  };
}

export function createSignal():
  SignalEngineResult {
  return {
    decision: TradeDecision.BUY,
    signal: {
      symbol: "XAUUSD",
      timeframe: "M15",
      type: SignalType.BUY,
      strength: SignalStrength.STRONG,
      confidence: 86,
      entry: 2400,
      stopLoss: 2395,
      takeProfit: 2411,
      reasons: ["Bullish alignment"],
      createdAt: NOW
    },
    score: {
      direction: "BULLISH",
      bullishPoints: 85,
      bearishPoints: 15,
      maximumPoints: 100,
      confidence: 85,
      directionalEdge: 70
    },
    levels: {
      entry: 2400,
      stopLoss: 2395,
      takeProfit: 2411,
      riskDistance: 5,
      rewardDistance: 11,
      riskReward: 2.2,
      stopSource: "ATR",
      targetSource: "R_MULTIPLE",
      partialTargets: []
    },
    rules: [],
    diagnostics: {
      accepted: true,
      rejectionCodes: [],
      notes: []
    },
    generatedAt: NOW
  };
}

export function createRisk():
  RiskAssessment {
  const order = {
    symbol: "XAUUSD",
    side: OrderSide.BUY,
    volume: 0.2,
    entry: 2400,
    stopLoss: 2395,
    takeProfit: 2411,
    clientOrderId: "risk-approved"
  };

  return {
    approved: true,
    decision: "APPROVE",
    order,
    commonResult: {
      approved: true,
      reason: "Approved",
      riskAmount: 100,
      riskPercent: 1,
      positionSize: 0.2,
      position: order
    },
    budget: {
      baseRiskPercent: 1,
      confidenceFactor: 1,
      strengthFactor: 1,
      drawdownFactor: 1,
      lossStreakFactor: 1,
      availablePortfolioRiskAmount: 400,
      requestedRiskPercent: 1,
      requestedRiskAmount: 100,
      approvedRiskPercent: 1,
      approvedRiskAmount: 100
    },
    sizing: {
      entry: 2400,
      stopLoss: 2395,
      stopDistance: 5,
      stopTicks: 500,
      riskPerLot: 500,
      rawVolume: 0.2,
      volume: 0.2,
      actualRiskAmount: 100,
      actualRiskPercent: 1,
      cappedAtMaximum: false,
      belowMinimum: false
    },
    margin: {
      notionalValue: 48000,
      requiredMargin: 480,
      projectedMargin: 680,
      projectedMarginUsagePercent: 6.8,
      projectedFreeMargin: 9320,
      projectedFreeMarginPercent: 93.2
    },
    exposure: {
      openPositionCount: 0,
      symbolPositionCount: 0,
      currentOpenRiskAmount: 0,
      projectedOpenRiskAmount: 100,
      projectedOpenRiskPercent: 1
    },
    rules: [],
    diagnostics: {
      accepted: true,
      rejectionCodes: [],
      warnings: [],
      notes: []
    },
    generatedAt: NOW
  };
}

export function createStrategy(
  overrides:
    Partial<StrategyEvaluation> = {}
): StrategyEvaluation {
  const order = createRisk().order!;
  return {
    action: "EXECUTE",
    plan: {
      order,
      selectedStrategy: {
        strategyId: "BREAKOUT_RETEST",
        name: "Breakout Retest",
        eligible: true,
        direction: SignalType.BUY,
        score: 90,
        rawScore: 90,
        scoreBreakdown: {
          signal: 20,
          structure: 15,
          regime: 15,
          momentum: 15,
          location: 10,
          multiTimeframe: 10,
          session: 5,
          total: 90
        },
        supportedRegimes: ["BREAKOUT"],
        supportedSessions: [TradingSession.LONDON],
        reasons: ["Confirmed breakout"],
        invalidations: [],
        warnings: []
      },
      regime: {
        regime: "BREAKOUT",
        confidence: 82,
        reasons: [],
        metrics: {
          adx: 28,
          bollingerBandwidth: 1.5,
          volatilityPercent: 1.2,
          confirmedBosCount: 2,
          confirmedChochCount: 0
        }
      },
      session: TradingSession.LONDON,
      management: {
        partialTargets: [],
        moveStopToBreakEvenAtR: 1,
        trailingStop: {
          enabled: true,
          startAtR: 1.5,
          mode: "ATR",
          atrMultiple: 1.5,
          neverWidenStop: true
        },
        maximumHoldingMinutes: 240,
        cancelIfNotFilledAfterMinutes: 5,
        hardInvalidationPrice: 2394,
        timeStopAt: NOW + 240 * 60_000
      },
      expiresAt: NOW + 300_000,
      generatedAt: NOW
    },
    regime: {
      regime: "BREAKOUT",
      confidence: 82,
      reasons: [],
      metrics: {
        adx: 28,
        bollingerBandwidth: 1.5,
        volatilityPercent: 1.2,
        confirmedBosCount: 2,
        confirmedChochCount: 0
      }
    },
    selection: {
      selected: {
        strategyId: "BREAKOUT_RETEST",
        name: "Breakout Retest",
        eligible: true,
        direction: SignalType.BUY,
        score: 90,
        rawScore: 90,
        scoreBreakdown: {
          signal: 20,
          structure: 15,
          regime: 15,
          momentum: 15,
          location: 10,
          multiTimeframe: 10,
          session: 5,
          total: 90
        },
        supportedRegimes: ["BREAKOUT"],
        supportedSessions: [TradingSession.LONDON],
        reasons: [],
        invalidations: [],
        warnings: []
      },
      runnerUp: null,
      edge: 20,
      ranked: []
    },
    rules: [],
    diagnostics: {
      accepted: true,
      rejectionCodes: [],
      warnings: [],
      notes: []
    },
    commonResult: {
      decision: TradeDecision.BUY,
      signal: createSignal().signal,
      confidence: 88,
      reasons: ["Breakout retest selected"],
      createdAt: NOW
    },
    generatedAt: NOW,
    ...overrides
  };
}

export function createBacktestMetrics():
  PerformanceMetrics {
  return {
    initialBalance: 10000,
    finalBalance: 12000,
    netProfit: 2000,
    netReturnPercent: 20,
    grossProfit: 5000,
    grossLoss: 3000,
    totalCommission: 200,
    totalTrades: 120,
    winningTrades: 66,
    losingTrades: 54,
    breakevenTrades: 0,
    winRatePercent: 55,
    profitFactor: 1.67,
    expectancy: 16.67,
    averageWin: 75.76,
    averageLoss: -55.56,
    payoffRatio: 1.36,
    averageRMultiple: 0.25,
    medianRMultiple: 0.1,
    maxDrawdownAmount: 800,
    maxDrawdownPercent: 7,
    maxConsecutiveWins: 6,
    maxConsecutiveLosses: 4,
    averageHoldingMinutes: 90,
    exposurePercent: 25,
    sharpeRatio: 1.2,
    sortinoRatio: 1.8,
    cagrPercent: 18,
    calmarRatio: 2.57
  };
}

export function createContext(
  overrides: Partial<AiContext> = {}
): AiContext {
  return {
    analysis: createAnalysis(),
    indicators: createIndicators(),
    signalResult: createSignal(),
    riskAssessment: createRisk(),
    strategyEvaluation: createStrategy(),
    backtestMetrics: createBacktestMetrics(),
    recentPerformance: {
      sampleSize: 20,
      winRatePercent: 55,
      profitFactor: 1.4,
      averageRMultiple: 0.2,
      maxDrawdownPercent: 3,
      consecutiveLosses: 0,
      generatedAt: NOW
    },
    evaluatedAt: NOW,
    ...overrides
  };
}

export function opinion(
  action:
    AiStructuredOpinion["action"],
  confidence = 90
): AiStructuredOpinion {
  return {
    schemaVersion: "1.0.0",
    action,
    confidence,
    marketQualityScore: 85,
    executionQualityScore: 85,
    riskQualityScore: 90,
    reasons: ["Structured conditions support the opinion."],
    warnings: [],
    invalidationConditions: ["Risk approval changes."],
    featureContributions: [
      {
        feature: "riskApproved",
        impact: 20,
        direction: "SUPPORT",
        explanation: "Risk Engine approved."
      }
    ]
  };
}
