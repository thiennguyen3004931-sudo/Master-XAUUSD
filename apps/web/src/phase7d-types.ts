export interface Phase7DDailyPnlRequest {
  from: string;
  to: string;
  fixedVolume: number;
  recoveryMinPrice: number;
  recoveryMaxPrice: number;
  profitBufferUsd: number;
  positiveLockFloorUsd: number;
  dayUtcOffsetHours: number;
}

export interface Phase7DDayRow {
  day: string;
  pnl: number;
  trades: number;
  blocked: number;
  recoveryTrades: number;
  wentNegative: boolean;
  recoveredFromNegative: boolean;
}

export interface Phase7DOutcome {
  entryTime: number;
  exitTime: number;
  side: "BUY" | "SELL";
  pattern: string;
  pnl: number;
  mode: "BASELINE" | "RECOVERY" | "TREND" | "BLOCKED_POSITIVE_LOCK";
  exitReason: string;
  recoveryTargetPriceMove: number | null;
  dayPnlBeforeEntry: number;
  initialRiskUsd: number;
  blocked: boolean;
  counterfactualCanonicalPnl: number | null;
}

export interface Phase7DLaneMetrics {
  trades: number;
  blockedTrades: number;
  skippedPositionBusy: number;
  winRatePercent: number;
  netPnl: number;
  profitFactor: number | null;
  expectancy: number;
  maxDrawdownUsd: number;
  activeDays: number;
  positiveDays: number;
  negativeDays: number;
  flatDays: number;
  positiveDayRatePercent: number;
  averageDailyPnl: number;
  medianDailyPnl: number;
  bestDayUsd: number;
  worstDayUsd: number;
  maxConsecutiveLosingDays: number;
  recoveredDays: number;
  recoveryTrades: number;
  recoveryTpHits: number;
  recoveryBeExits: number;
  averageRecoveryTargetPrice: number;
  positiveLockBlockedTrades: number;
  positiveLockBlockedDays: number;
  blockedCounterfactualWinRatePercent: number;
  blockedCounterfactualNetPnl: number;
  blockedCounterfactualProfitFactor: number | null;
  blockedCounterfactualGrossProfit: number;
  blockedCounterfactualGrossLoss: number;
  blockedInitialRiskUsd: number;
  lockEstimatedPnlSavedUsd: number;
}

export type Phase7DLaneName = "BASELINE" | "RECOVERY" | "TREND_PLUS_LOCK" | "RECOVERY_PLUS_LOCK";

export interface Phase7DLaneResult {
  lane: Phase7DLaneName;
  metrics: Phase7DLaneMetrics;
  days: Phase7DDayRow[];
  outcomes: Phase7DOutcome[];
}

export interface Phase7DDailyPnlResult {
  source: "PHASE7D_DAILY_PNL_RESEARCH";
  generatedAt: number;
  replayMode: "EXACT_PER_LANE_SIGNAL_CONTENTION_WITH_M5_APPROXIMATION";
  safety: {
    researchOnly: true;
    executionMutation: false;
    phase7bStrategyMutation: false;
    fixedVolumeUnchanged: true;
    liveUnlockAvailable: false;
    profitGuarantee: false;
  };
  configuration: {
    from: string;
    to: string;
    fixedVolume: number;
    recoveryMinPrice: number;
    recoveryMaxPrice: number;
    profitBufferUsd: number;
    positiveLockFloorUsd: number;
    dayUtcOffsetHours: number;
    comparedTradeSchedule: number;
    fullPeriodCanonicalTrades: number;
    journalTradeLimitApplied: boolean;
    signals: number;
    filledCandidateTrades: number;
    baselineSkippedPositionBusy: number;
    recoverySkippedPositionBusy: number;
    trendPlusLockSkippedPositionBusy: number;
    recoveryPlusLockSkippedPositionBusy: number;
    accountLogin: number | null;
    server: string | null;
  };
  baseline: Phase7DLaneResult;
  recovery: Phase7DLaneResult;
  trendPlusLock: Phase7DLaneResult;
  recoveryPlusLock: Phase7DLaneResult;
  decision: {
    sampleTrades: number;
    sampleDays: number;
    sufficientSample: boolean;
    recommendedLane: string;
    verdict: "INSUFFICIENT_SAMPLE" | "RESEARCH_PROMISING" | "NO_CLEAR_IMPROVEMENT";
    executionEligible: false;
    bestResearchScore: number;
    candidates: Array<{
      lane: "RECOVERY" | "TREND_PLUS_LOCK" | "RECOVERY_PLUS_LOCK";
      score: number;
      metrics: Phase7DLaneMetrics;
      deltas: {
        positiveDayRatePercent: number;
        netPnl: number;
        profitFactor: number | null;
        maxDrawdownUsd: number;
        worstDayUsd: number;
      };
    }>;
    lockIsolation: {
      trendPlusLockScore: number;
      recoveryPlusLockScore: number;
      interpretation: string;
    };
    reason: string;
  };
  notes: string[];
}
