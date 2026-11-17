import type { EntryCompressionSource } from "./EntryCompression";
import type { Phase4M5Bar } from "./Phase4M5Research";

export interface Phase4ShadowTradeCase {
  id: string;
  side: "BUY" | "SELL";
  signalTimestamp: number;
  entryExpiresAt: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  volume: number;
  tickSize: number;
  tickValuePerLot: number;
  m5Bars: readonly Phase4M5Bar[];
  entrySource?: EntryCompressionSource | "CANONICAL";
}

export interface Phase4ShadowManagementConfig {
  breakEvenTriggerPrice: number;
  breakEvenOffsetPrice: number;
  trailingTriggerPrice: number;
  trailingDistancePrice: number;
}

export interface Phase4ShadowTradeResult {
  id: string;
  side: "BUY" | "SELL";
  entrySource: string;
  filled: boolean;
  entryTime: number | null;
  exitTime: number | null;
  entry: number;
  exit: number | null;
  initialStopLoss: number;
  finalStopLoss: number;
  takeProfit: number;
  pnl: number;
  initialRiskUsd: number;
  rMultiple: number;
  mfePrice: number;
  maePrice: number;
  reachedPlus6: boolean;
  reachedPlus10: boolean;
  breakEvenApplied: boolean;
  trailingActivated: boolean;
  exitReason: string;
}

export interface Phase4ShadowReplayMetrics {
  totalCases: number;
  filledTrades: number;
  unfilledTrades: number;
  wins: number;
  losses: number;
  flat: number;
  winRatePercent: number;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  expectancy: number;
  averageRMultiple: number;
  averageMfePrice: number;
  averageMaePrice: number;
  reachedPlus6: number;
  reachedPlus10: number;
  breakEvenApplied: number;
  trailingActivated: number;
}

export interface Phase4ShadowReplayResult {
  metrics: Phase4ShadowReplayMetrics;
  trades: Phase4ShadowTradeResult[];
}
