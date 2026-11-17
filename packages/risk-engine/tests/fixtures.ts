import type { SignalEngineResult } from "@xauusd/signal-engine";
import {
  MarketStructure,
  SignalStrength,
  SignalType,
  TradeDecision,
  Trend,
  type Account,
} from "@xauusd/types";
import type {
  InstrumentRiskSpec,
  PortfolioRiskSnapshot,
  RiskContext,
} from "../src";

const generatedAt = 1_700_000_000_000;

export function createSignalResult(
  overrides: Partial<SignalEngineResult> = {},
): SignalEngineResult {
  const signal = {
    symbol: "XAUUSD",
    timeframe: "M15",
    type: SignalType.BUY,
    strength: SignalStrength.STRONG,
    confidence: 85,
    entry: 2400,
    stopLoss: 2395,
    takeProfit: 2411,
    reasons: ["Bullish structure and momentum alignment"],
    createdAt: generatedAt,
  };

  return {
    decision: TradeDecision.BUY,
    signal,
    score: {
      direction: "BULLISH",
      bullishPoints: 82,
      bearishPoints: 18,
      maximumPoints: 100,
      confidence: 82,
      directionalEdge: 64,
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
    },
    rules: [],
    diagnostics: {
      accepted: true,
      rejectionCodes: [],
      notes: [],
    },
    generatedAt,
    ...overrides,
  };
}

export function createAccount(
  overrides: Partial<Account> = {},
): Account {
  return {
    id: "account-1",
    broker: "Demo Broker",
    balance: 10_000,
    equity: 10_000,
    margin: 200,
    freeMargin: 9_800,
    leverage: 100,
    currency: "USD",
    ...overrides,
  };
}

export function createInstrument(
  overrides: Partial<InstrumentRiskSpec> = {},
): InstrumentRiskSpec {
  return {
    symbol: "XAUUSD",
    tickSize: 0.01,
    tickValuePerLot: 1,
    contractSize: 100,
    minVolume: 0.01,
    maxVolume: 10,
    volumeStep: 0.01,
    maxSpread: 0.5,
    priceDigits: 2,
    ...overrides,
  };
}

export function createPortfolio(
  overrides: Partial<PortfolioRiskSnapshot> = {},
): PortfolioRiskSnapshot {
  return {
    openPositions: [],
    dailyRealizedPnl: 0,
    dailyUnrealizedPnl: 0,
    peakEquity: 10_000,
    consecutiveLosses: 0,
    spread: 0.2,
    ...overrides,
  };
}

export function createRiskContext(
  overrides: Partial<RiskContext> = {},
): RiskContext {
  return {
    signalResult: createSignalResult(),
    account: createAccount(),
    portfolio: createPortfolio(),
    instrument: createInstrument(),
    evaluatedAt: generatedAt + 3_600_000,
    ...overrides,
  };
}
