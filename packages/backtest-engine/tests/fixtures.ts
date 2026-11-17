import { Timeframe, type Candle } from "@xauusd/market-data";
import type {
  MarketRegimeAssessment,
  StrategyCandidate,
  StrategyEvaluation,
} from "@xauusd/strategy-engine";
import {
  OrderSide,
  SignalStrength,
  SignalType,
  TradeDecision,
  TradingSession,
} from "@xauusd/types";

export const START = Date.UTC(2025, 0, 1);

export function createCandles(
  closes: readonly number[],
  spread = 0,
): Candle[] {
  return closes.map((close, index) => {
    const open = index === 0 ? close : closes[index - 1]!;
    return {
      symbol: "XAUUSD",
      timeframe: Timeframe.M15,
      openTime: START + index * 15 * 60_000,
      closeTime: START + (index + 1) * 15 * 60_000,
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 100 + index,
      spread,
    };
  });
}

function regime(
  name: MarketRegimeAssessment["regime"],
  confidence: number,
): MarketRegimeAssessment {
  return {
    regime: name,
    confidence,
    reasons: [],
    metrics: {
      adx: null,
      bollingerBandwidth: null,
      volatilityPercent: 0,
      confirmedBosCount: 0,
      confirmedChochCount: 0,
    },
  };
}

function candidate(
  direction: SignalType,
): StrategyCandidate {
  return {
    strategyId: "TREND_CONTINUATION",
    name: "Test Strategy",
    eligible: true,
    direction,
    score: 90,
    rawScore: 90,
    scoreBreakdown: {
      signal: 15,
      structure: 15,
      regime: 15,
      momentum: 15,
      location: 10,
      multiTimeframe: 10,
      session: 10,
      total: 90,
    },
    supportedRegimes: ["TRENDING"],
    supportedSessions: [TradingSession.LONDON],
    reasons: [],
    invalidations: [],
    warnings: [],
  };
}

export function waitEvaluation(
  timestamp = START,
): StrategyEvaluation {
  const regimeAssessment = regime("RANGING", 50);

  return {
    action: "WAIT",
    plan: null,
    regime: regimeAssessment,
    selection: {
      selected: null,
      runnerUp: null,
      edge: 0,
      ranked: [],
    },
    rules: [],
    diagnostics: {
      accepted: false,
      rejectionCodes: [],
      warnings: [],
      notes: [],
    },
    commonResult: {
      decision: TradeDecision.WAIT,
      signal: null,
      confidence: 0,
      reasons: [],
      createdAt: timestamp,
    },
    generatedAt: timestamp,
  };
}

export function executeEvaluation(
  side: OrderSide,
  generatedAt: number,
  entry: number,
  stopLoss: number,
  takeProfit: number,
  volume = 1,
  partialTargets: Array<{
    label: "TP1" | "TP2" | "TP3";
    price: number;
    closePercent: number;
    rewardMultiple: number;
  }> = [],
): StrategyEvaluation {
  const signalType =
    side === OrderSide.BUY ? SignalType.BUY : SignalType.SELL;
  const selected = candidate(signalType);
  const regimeAssessment = regime("TRENDING", 90);
  const signal = {
    symbol: "XAUUSD",
    timeframe: "M15",
    type: signalType,
    strength: SignalStrength.STRONG,
    confidence: 90,
    entry,
    stopLoss,
    takeProfit,
    reasons: [],
    createdAt: generatedAt,
  };

  return {
    action: "EXECUTE",
    plan: {
      order: {
        symbol: "XAUUSD",
        side,
        volume,
        entry,
        stopLoss,
        takeProfit,
        clientOrderId: `test-${generatedAt}`,
      },
      selectedStrategy: selected,
      regime: regimeAssessment,
      session: TradingSession.LONDON,
      management: {
        partialTargets,
        moveStopToBreakEvenAtR: 100,
        trailingStop: {
          enabled: false,
          startAtR: 100,
          mode: "ATR",
          atrMultiple: 1.5,
          neverWidenStop: true,
        },
        maximumHoldingMinutes: 240,
        cancelIfNotFilledAfterMinutes: 60,
        hardInvalidationPrice:
          side === OrderSide.BUY
            ? stopLoss - 10
            : stopLoss + 10,
        timeStopAt: generatedAt + 24 * 60 * 60_000,
      },
      expiresAt: generatedAt + 4 * 60 * 60_000,
      generatedAt,
    },
    regime: regimeAssessment,
    selection: {
      selected,
      runnerUp: null,
      edge: 90,
      ranked: [selected],
    },
    rules: [],
    diagnostics: {
      accepted: true,
      rejectionCodes: [],
      warnings: [],
      notes: [],
    },
    commonResult: {
      decision:
        side === OrderSide.BUY
          ? TradeDecision.BUY
          : TradeDecision.SELL,
      signal,
      confidence: 90,
      reasons: [],
      createdAt: generatedAt,
    },
    generatedAt,
  };
}
