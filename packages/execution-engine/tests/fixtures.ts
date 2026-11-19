import type { StrategyEvaluation } from "@xauusd/strategy-engine";
import {
  OrderSide,
  PositionSide,
  SignalStrength,
  SignalType,
  TradeDecision,
  TradingSession,
  type Position,
} from "@xauusd/types";
import type {
  ExecutionQuote,
  PositionManagementContext,
  SymbolExecutionSpec,
} from "../src";

export const NOW = 1_700_000_000_000;

function createCandidate() {
  return {
    strategyId: "BREAKOUT_RETEST" as const,
    name: "Breakout Retest",
    eligible: true,
    direction: SignalType.BUY,
    score: 88,
    rawScore: 88,
    scoreBreakdown: {
      signal: 18,
      structure: 16,
      regime: 15,
      momentum: 12,
      location: 10,
      multiTimeframe: 9,
      session: 8,
      total: 88,
    },
    supportedRegimes: ["BREAKOUT"] as const,
    supportedSessions: [TradingSession.LONDON] as const,
    reasons: ["Confirmed bullish breakout"],
    invalidations: ["Breakout structure fails"],
    warnings: [],
  };
}

function createRegime() {
  return {
    regime: "BREAKOUT" as const,
    confidence: 80,
    reasons: ["BOS confirmed"],
    metrics: {
      adx: 32,
      bollingerBandwidth: 0.006,
      volatilityPercent: 0.8,
      confirmedBosCount: 1,
      confirmedChochCount: 0,
    },
  };
}

export function createStrategyEvaluation(
  overrides: Partial<StrategyEvaluation> = {},
): StrategyEvaluation {
  const order = {
    symbol: "XAUUSD",
    side: OrderSide.BUY,
    volume: 0.2,
    entry: 2400,
    stopLoss: 2395,
    takeProfit: 2411,
    clientOrderId: "strategy-xau-buy-001",
    comment: "Pack 07 approved",
  };
  const candidate = createCandidate();
  const regime = createRegime();
  const signal = {
    symbol: "XAUUSD",
    timeframe: "M15",
    type: SignalType.BUY,
    strength: SignalStrength.STRONG,
    confidence: 85,
    entry: 2400,
    stopLoss: 2395,
    takeProfit: 2411,
    reasons: ["Breakout retest selected"],
    createdAt: NOW,
  };

  return {
    action: "EXECUTE",
    plan: {
      order,
      selectedStrategy: candidate,
      regime,
      session: TradingSession.LONDON,
      management: {
        partialTargets: [
          {
            label: "TP1",
            price: 2405,
            closePercent: 30,
            rewardMultiple: 1,
          },
          {
            label: "TP2",
            price: 2408,
            closePercent: 30,
            rewardMultiple: 1.6,
          },
          {
            label: "TP3",
            price: 2411,
            closePercent: 40,
            rewardMultiple: 2.2,
          },
        ],
        moveStopToBreakEvenAtR: 1,
        trailingStop: {
          enabled: true,
          startAtR: 1.5,
          mode: "ATR",
          atrMultiple: 1.5,
          neverWidenStop: true,
        },
        maximumHoldingMinutes: 240,
        cancelIfNotFilledAfterMinutes: 5,
        hardInvalidationPrice: 2394,
        timeStopAt: NOW + 240 * 60_000,
      },
      expiresAt: NOW + 5 * 60_000,
      generatedAt: NOW,
    },
    regime,
    selection: {
      selected: candidate,
      runnerUp: null,
      edge: 88,
      ranked: [candidate],
    },
    rules: [],
    diagnostics: {
      accepted: true,
      rejectionCodes: [],
      warnings: [],
      notes: [],
    },
    commonResult: {
      decision: TradeDecision.BUY,
      signal,
      confidence: 85,
      reasons: ["Breakout retest selected"],
      createdAt: NOW,
    },
    generatedAt: NOW,
    ...overrides,
  };
}

export function createQuote(
  overrides: Partial<ExecutionQuote> = {},
): ExecutionQuote {
  return {
    symbol: "XAUUSD",
    bid: 2399.9,
    ask: 2400,
    spread: 0.1,
    timestamp: NOW + 60_000,
    ...overrides,
  };
}

export function createSpec(
  overrides: Partial<SymbolExecutionSpec> = {},
): SymbolExecutionSpec {
  return {
    symbol: "XAUUSD",
    tickSize: 0.01,
    digits: 2,
    minVolume: 0.01,
    maxVolume: 10,
    volumeStep: 0.01,
    maxSpread: 0.5,
    stopsLevelTicks: 10,
    freezeLevelTicks: 5,
    ...overrides,
  };
}

export function createPosition(
  overrides: Partial<Position> = {},
): Position {
  return {
    ticket: "ticket-1",
    symbol: "XAUUSD",
    side: PositionSide.LONG,
    volume: 0.2,
    entry: 2400,
    stopLoss: 2395,
    takeProfit: 2411,
    profit: 0,
    swap: 0,
    commission: 0,
    openedAt: NOW,
    ...overrides,
  };
}

export function createManagementContext(
  overrides: Partial<PositionManagementContext> = {},
): PositionManagementContext {
  const evaluation = createStrategyEvaluation();
  if (!evaluation.plan) {
    throw new Error("Fixture strategy plan is missing.");
  }

  return {
    plan: evaluation.plan,
    position: createPosition(),
    quote: createQuote({
      bid: 2405,
      ask: 2405.1,
      timestamp: NOW + 90_000,
    }),
    spec: createSpec(),
    atr: 2,
    state: {
      initialVolume: 0.2,
      completedTargetLabels: [],
      breakEvenApplied: false,
    },
    evaluatedAt: NOW + 90_000,
    ...overrides,
  };
}
