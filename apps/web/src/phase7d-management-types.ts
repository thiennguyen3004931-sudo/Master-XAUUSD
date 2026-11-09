export interface Phase7DManagementRequest {
  from: string;
  to: string;
  fixedVolume: number;
}

export interface Phase7DManagementMetrics {
  trades: number;
  skippedWhileOpen: number;
  winRatePercent: number;
  netPnl: number;
  profitFactor: number | null;
  expectancy: number;
  averageR: number;
  maxDrawdownUsd: number;
  averageHoldHours: number;
  plus6Reached: number;
  plus6RatePercent: number;
  plus10Reached: number;
  plus10RatePercent: number;
  breakEvenStopExits: number;
  beStopBeforePlus10: number;
  beStopBeforePlus10RatePercent: number;
  plus6ThenFullStopBefore10: number;
  plus6ThenFullStopBefore10RatePercent: number;
  partialApplied: number;
  averagePartialPnlUsd: number;
}

export interface Phase7DManagementVariant {
  name: "CURRENT_BE6_PARTIAL_THIRD" | "BE10_PARTIAL_THIRD" | "BE10_PARTIAL_HALF_THEORETICAL";
  config: {
    beTrigger: number;
    partialTrigger: number;
    partialFraction: number;
    partialVolumeAtFixedLot: number;
    runnerVolumeAtFixedLot: number;
    executableWithBrokerStep: boolean;
    theoreticalOnly: boolean;
  };
  metrics: Phase7DManagementMetrics;
}

export interface Phase7DManagementResult {
  source: "PHASE7D_BE_PARTIAL_MANAGEMENT_RESEARCH";
  replayMode: "EXACT_PER_VARIANT_SIGNAL_CONTENTION_WITH_M5_APPROXIMATION";
  generatedAt: number;
  safety: {
    researchOnly: true;
    executionMutation: false;
    phase7bStrategyMutation: false;
    liveUnlockAvailable: false;
  };
  range: { from: string; to: string; days: number };
  broker: {
    accountLogin: number | null;
    server: string | null;
    symbol: string;
    fixedVolume: number;
    minVolume: number;
    volumeStep: number;
  };
  signals: number;
  variants: Phase7DManagementVariant[];
  decision: {
    sufficientSample: boolean;
    verdict: "INSUFFICIENT_SAMPLE" | "BE10_THIRD_RESEARCH_PROMISING" | "BE10_THIRD_MIXED" | "KEEP_CURRENT_BE6_RESEARCH";
    executionEligible: false;
    preferredExecutableResearchVariant: "CURRENT_BE6_PARTIAL_THIRD" | "BE10_PARTIAL_THIRD";
    deltaBe10ThirdVsCurrent: {
      trades: number;
      winRatePercent: number;
      netPnl: number;
      profitFactor: number | null;
      expectancy: number;
      maxDrawdownUsd: number;
      plus10RatePercent: number;
      beStopsAvoidedBefore10: number;
      extraFullStopsAfterPlus6: number;
    };
    theoreticalHalfNetDeltaVsThird: number;
    reason: string;
  };
  notes: string[];
}
