export type Phase7CPerformanceCorrelationVerdict = "EXACT" | "AMBIGUOUS" | "UNMATCHED";
export type Phase7CExecutionStrategy = "TREND" | "SIDEWAY";
export type Phase7CPerformanceStrategy = Phase7CExecutionStrategy | "REVERSAL";
export type Phase7CPerformanceEntryType = "IMMEDIATE" | "PULLBACK" | "RECOVERY" | "UNKNOWN";

export interface Phase7CPerformanceIntelligenceTrade {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  strategy: Phase7CExecutionStrategy;
  openedAt: number;
  closedAt: number;
  volume: number;
  netPnl: number;
  positionId: string;
  correlation: {
    verdict: Phase7CPerformanceCorrelationVerdict;
    method: "EXPLICIT_IDENTITY_GRAPH" | "NONE";
    evidence: string[];
  };
  attribution: {
    entryType: Phase7CPerformanceEntryType;
    regime: string | null;
    entryPolicy: string | null;
    performanceStrategy: Phase7CPerformanceStrategy;
    confirmationAgeBars: number | null;
    passedRules: string[];
    blockedRules: string[];
    decisionEventIds: string[];
  };
}

export interface Phase7CPerformanceIntelligenceSnapshot {
  version: 2;
  source: "PHASE7C_PERFORMANCE_INTELLIGENCE";
  generatedAt: number;
  symbol: string;
  days: number;
  account: {
    accountMode: "DEMO" | "LIVE";
    brokerMode: "demo" | "real";
    login: number | null;
    server: string | null;
  };
  accountingSource: "MT5_ACCOUNT_READ_ONLY";
  safety: {
    readOnly: true;
    strategyMutation: false;
    riskMutation: false;
    orderMutation: false;
    positionMutation: false;
    modeMutation: false;
    armMutation: false;
    autoRetune: false;
  };
  coverage: {
    totalSystemTrades: number;
    exactTrades: number;
    ambiguousTrades: number;
    unmatchedTrades: number;
    correlationCoveragePercent: number;
    ruleEvidenceTrades: number;
    regimeEvidenceTrades: number;
  };
  auditSources: Array<{
    strategy: Phase7CExecutionStrategy;
    relativePath: string;
    available: boolean;
    parsedRows: number;
    malformedRows: number;
  }>;
  trades: Phase7CPerformanceIntelligenceTrade[];
  rules: Array<{
    rule: string;
    strategy: Phase7CPerformanceStrategy;
    sampleSize: number;
    wins: number;
    losses: number;
    breakeven: number;
    netPnl: number;
    expectancy: number;
    profitFactor: number | null;
    correlationCoveragePercent: number;
  }>;
  entryTypes: Array<{
    entryType: Phase7CPerformanceEntryType;
    sampleSize: number;
    netPnl: number;
    expectancy: number;
    winRatePercent: number;
    profitFactor: number | null;
  }>;
  sidewayM5Confirmation: Array<{
    path: "M5_CURRENT" | "M5_CARRY_1" | "M5_CARRY_OTHER" | "UNKNOWN";
    ageBars: 0 | 1 | null;
    sampleSize: number;
    wins: number;
    losses: number;
    breakeven: number;
    netPnl: number;
    expectancy: number;
    winRatePercent: number;
    profitFactor: number | null;
  }>;
  entryFunnel: Array<{
    strategy: Phase7CPerformanceStrategy;
    observedEntryDecisionEvents: number;
    ruleEvaluatedEvents: number;
    blockedEvents: number;
    clearRuleEvents: number;
    entrySubmitEvents: number;
    entryFilledEvents: number;
    blockedReasons: Array<{ rule: string; count: number }>;
  }>;
  decisionBlocks: Array<{
    strategy: Phase7CPerformanceStrategy;
    rule: string;
    count: number;
  }>;
  notes: string[];
}

export interface Phase7CPerformanceCorrelationRow {
  schemaVersion: "phase7c-performance-correlation-v1";
  tradeKey: string;
  symbol: string;
  accountMode: "DEMO" | "LIVE";
  trade: {
    performanceTradeId: string;
    positionId: string;
    strategy: Phase7CExecutionStrategy;
    side: "BUY" | "SELL";
    volume: number;
    openedAt: number;
    closedAt: number;
    netPnl: number;
  };
  correlation: {
    verdict: Phase7CPerformanceCorrelationVerdict;
    method: "EXPLICIT_IDENTITY_GRAPH" | "NONE";
    evidence: string[];
    candidatePositionCount: number | null;
  };
  attribution: {
    entryType: Phase7CPerformanceEntryType;
    regime: string | null;
    entryPolicy?: string | null;
    performanceStrategy?: Phase7CPerformanceStrategy;
    confirmationAgeBars?: number | null;
    passedRules: string[];
    blockedRules: string[];
    decisionEventIds: string[];
  };
}
