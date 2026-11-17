import type { Phase7CBacktestResult } from "./phase7c-types";

export interface Phase7CAutoLotBacktestRequest {
  from: string;
  to: string;
  fixedVolume: number;
  riskPercent: number;
  maxAutoLot: number;
  startingBalance?: number;
}

export interface Phase7CAutoLotShadowTrade {
  entryTime: number;
  side: "BUY" | "SELL";
  pattern: string;
  stopDistance: number;
  fixedLot: number;
  fixedPnl: number;
  balanceBefore: number;
  targetRiskUsd: number;
  rawLot: number;
  autoLot: number;
  autoRiskUsd: number;
  autoRiskPercent: number;
  autoPnl: number;
  balanceAfter: number;
  status: "EXECUTE" | "BLOCK";
  reason: string;
}

export interface Phase7CAutoLotDecisionCriterion {
  key: string;
  label: string;
  pass: boolean;
  score: number;
  maxScore: number;
  detail: string;
}

export interface Phase7CAutoLotBacktestResult {
  source: "PHASE7C_AUTO_LOT_SHADOW_COMPARISON";
  generatedAt: number;
  safety: {
    mode: "AUTO_LOT_SHADOW_BACKTEST";
    executionMutation: false;
    phase7bFixedVolumeUnchanged: true;
    liveUnlockAvailable: false;
    strategyRuleMutation: false;
  };
  configuration: {
    riskPercent: number;
    maxAutoLot: number;
    fixedVolume: number;
    startingBalance: number;
    startingBalanceSource: "USER_RESEARCH_INPUT" | "CURRENT_MT5_BALANCE";
    volumeStep: number;
    minVolume: number;
    managementCompatibility: "EXACT_ONE_THIRD_PARTIAL_ONLY";
    comparedTradeSchedule: number;
    fullPeriodCanonicalTrades: number;
    journalTradeLimitApplied: boolean;
  };
  fixed: {
    trades: number;
    winRatePercent: number;
    netPnl: number;
    profitFactor: number | null;
    expectancy: number;
    maxDrawdownUsd: number;
    endingBalance: number;
    averageLot: number;
  };
  autoLot: {
    trades: number;
    winRatePercent: number;
    netPnl: number;
    profitFactor: number | null;
    expectancy: number;
    maxDrawdownUsd: number;
    endingBalance: number;
    attemptedTrades: number;
    executedTrades: number;
    blockedTrades: number;
    blockRatePercent: number;
    averageTargetRiskUsd: number;
    averageRiskUsd: number;
    averageRiskPercent: number;
    riskStdDevPercent: number;
    minLot: number;
    maxLot: number;
    averageLot: number;
  };
  deltaAutoMinusFixed: {
    trades: number;
    netPnl: number;
    winRatePercent: number;
    profitFactor: number | null;
    expectancy: number;
    maxDrawdownUsd: number;
    endingBalance: number;
  };
  decision: {
    score: number;
    maxScore: 100;
    verdict: "INSUFFICIENT_SAMPLE" | "REJECT_AUTO_LOT" | "KEEP_FIXED" | "NEEDS_MORE_DATA" | "SHADOW_PROMISING";
    reason: string;
    minimumSampleTrades: number;
    sampleTrades: number;
    executionEligible: false;
    criteria: Phase7CAutoLotDecisionCriterion[];
  };
  backtest: Phase7CBacktestResult;
  shadowTrades: Phase7CAutoLotShadowTrade[];
  notes: string[];
}
