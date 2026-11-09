export type Phase7ERealignmentRequest = {
  from: string;
  to: string;
  fixedVolume: number;
  atrPeriod: number;
  multiplier: number;
};

export type Phase7ERealignmentMetrics = {
  trades: number;
  skippedWhileOpen: number;
  winRatePercent: number;
  netPnl: number;
  profitFactor: number | null;
  expectancy: number;
  averageR: number;
  maxDrawdownUsd: number;
  averageHoldHours: number;
};

export type Phase7ERealignmentVariant = {
  name: "DUAL_STATE" | "M5_FLIP_1" | "M5_FLIP_2" | "M5_FLIP_3";
  maxFlipAgeBars: number | null;
  acceptedSignals: number;
  metrics: Phase7ERealignmentMetrics;
  buy: Phase7ERealignmentMetrics;
  sell: Phase7ERealignmentMetrics;
  engulfing: Phase7ERealignmentMetrics;
  twoCandle: Phase7ERealignmentMetrics;
};

export type Phase7ERealignmentResult = {
  source: string;
  replayMode: string;
  generatedAt: number;
  safety: {
    researchOnly: boolean;
    executionMutation: boolean;
    phase7bStrategyMutation: boolean;
    liveUnlockAvailable: boolean;
    profitGuarantee: boolean;
  };
  configuration: {
    from: string;
    to: string;
    days: number;
    fixedVolume: number;
    atrPeriod: number;
    multiplier: number;
    maEntryFilter: string;
    m15Rule: string;
    m5Rule: string;
    freshFlipWindows: number[];
    management: string;
    accountLogin: number | null;
    server: string | null;
    symbol: string;
  };
  signalDiagnostics: {
    patternSignals: number;
    m15Aligned: number;
    dualStateAligned: number;
    timeframeDisagreement: number;
    dualSignals: number;
    flip1Signals: number;
    flip2Signals: number;
    flip3Signals: number;
  };
  maBaseline: { metrics: Phase7ERealignmentMetrics };
  variants: Phase7ERealignmentVariant[];
  decision: {
    sufficientSample: boolean;
    preferredResearchLane: string;
    verdict: string;
    executionEligible: boolean;
    reason: string;
  };
  notes: string[];
};
