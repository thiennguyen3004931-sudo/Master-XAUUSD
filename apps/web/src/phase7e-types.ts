export type Phase7ESupertrendRequest = {
  from: string;
  to: string;
  fixedVolume: number;
  atrPeriod: number;
  multiplier: number;
};

export type Phase7EMetrics = {
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

export type Phase7ESupertrendResult = {
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
    entryRule: string;
    maEntryFilter: string;
    m15SupertrendSource: string;
    m5SupertrendSource: string;
    management: string;
    accountLogin: number | null;
    server: string | null;
    symbol: string;
  };
  signalDiagnostics: {
    patternSignals: number;
    m15Aligned: number;
    m5Aligned: number;
    dualAligned: number;
    timeframeDisagreement: number;
    acceptedSignals: number;
    buySignals: number;
    sellSignals: number;
  };
  baseline: {
    source: string;
    entryRule: string;
    metrics: Phase7EMetrics;
  };
  supertrend: {
    metrics: Phase7EMetrics;
    buy: Phase7EMetrics;
    sell: Phase7EMetrics;
    engulfing: Phase7EMetrics;
    twoCandle: Phase7EMetrics;
    trades: Array<{
      entryTime: number;
      exitTime: number;
      side: "BUY" | "SELL";
      pattern: string;
      entry: number;
      exit: number;
      pnl: number;
      exitReason: string;
    }>;
  };
  comparison: {
    tradesDelta: number;
    winRateDeltaPp: number;
    netPnlDelta: number;
    profitFactorDelta: number | null;
    expectancyDelta: number;
    maxDrawdownDelta: number;
  };
  decision: {
    sufficientSample: boolean;
    verdict: string;
    executionEligible: boolean;
    reason: string;
  };
  notes: string[];
};
