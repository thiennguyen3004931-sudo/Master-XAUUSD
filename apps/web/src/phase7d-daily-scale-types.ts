export type Phase7DDailyScaleRequest = {
  from: string;
  to: string;
  fixedVolume?: number;
  recoveryMinPrice?: number;
  recoveryMaxPrice?: number;
  profitBufferUsd?: number;
  positiveLockFloorUsd?: number;
  dayUtcOffsetHours?: number;
};

export type Phase7DDailyScaleMetrics = {
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
  positiveDayRatePercent: number;
  worstDayUsd: number;
  averageDailyPnl: number;
  recoveredDays: number;
  recoveryTrades: number;
  recoveryTpHits: number;
  recoveryBeExits?: number;
  plus10Hits: number;
  plus10RatePercent: number;
  plus20Hits: number;
  plus20RatePercent: number;
  beStopsBefore10: number;
  firstPartialPnl: number;
  secondPartialPnl: number;
  runnerPnl: number;
};

export type Phase7DDailyScaleLane = {
  lane: "CURRENT" | "RECOVERY_LOCK_CURRENT" | "RECOVERY_LOCK_SCALE_BE6" | "RECOVERY_LOCK_SCALE_BE10";
  metrics: Phase7DDailyScaleMetrics;
  days: Array<{ day: string; pnl: number; trades: number; blocked: number; wentNegative: boolean; recoveredFromNegative: boolean }>;
  outcomes: Array<Record<string, unknown>>;
};

export type Phase7DReconciliationCheck = {
  key: string;
  pass: boolean;
  expected: number | string | null;
  actual: number | string | null;
  delta: number | null;
  tolerance: number | null;
};

export type Phase7DDailyScaleResult = {
  source: "PHASE7D_DAILY_RECOVERY_TREND_SCALE_RESEARCH";
  replayMode: "EXACT_PER_LANE_SIGNAL_CONTENTION_WITH_M5_APPROXIMATION";
  generatedAt: number;
  safety: {
    researchOnly: boolean;
    executionMutation: boolean;
    phase7bStrategyMutation: boolean;
    fixedVolumeUnchanged: boolean;
    liveUnlockAvailable: boolean;
    profitGuarantee: boolean;
  };
  configuration: {
    from: string;
    to: string;
    days: number;
    fixedVolume: number;
    recoveryMinPrice: number;
    recoveryMaxPrice: number;
    profitBufferUsd: number;
    positiveLockFloorUsd: number;
    dayUtcOffsetHours: number;
    recoveryStopPolicy?: string;
    signals: number;
    filledCandidates: number;
    accountLogin: number | null;
    server: string | null;
    volumeStep: number;
    firstPartialVolume: number;
    secondPartialVolume: number;
    finalRunnerVolume: number;
  };
  current: Phase7DDailyScaleLane;
  recoveryLockCurrent: Phase7DDailyScaleLane;
  scaleBe6: Phase7DDailyScaleLane;
  scaleBe10: Phase7DDailyScaleLane;
  reconciliation: {
    status: "PASS" | "FAIL";
    passed: boolean;
    decisionAllowed: boolean;
    canonicalReference: string;
    checks: Phase7DReconciliationCheck[];
    failedKeys: string[];
    references: Record<string, unknown>;
    note: string;
  };
  decision: {
    sampleTrades: number;
    sampleDays: number;
    sufficientSample: boolean;
    verdict: "INSUFFICIENT_SAMPLE" | "SCALE_RESEARCH_PROMISING" | "KEEP_CURRENT_RECOVERY_LOCK" | "RECONCILIATION_FAILED";
    preferredResearchLane: string;
    executionEligible: false;
    candidates: Array<{
      lane: string;
      score: number;
      metrics: Phase7DDailyScaleMetrics;
      deltas: {
        netPnl: number;
        profitFactor: number | null;
        maxDrawdownUsd: number;
        positiveDayRatePercent: number;
        expectancy: number;
      };
    }>;
    reason: string;
  };
  notes: string[];
};
