export type Phase7CPerformanceStrategy = "TREND" | "SIDEWAY" | "REVERSAL";
export type Phase7CPerformanceSide = "BUY" | "SELL";
export type Phase7CPerformanceEntryType = "IMMEDIATE" | "PULLBACK" | "RECOVERY" | "UNKNOWN";
export type Phase7CPerformanceCorrelationVerdict = "EXACT" | "AMBIGUOUS" | "UNMATCHED";
export type Phase7CPerformanceExcursionEvidence = "COMPLETE_M5_WINDOW" | "INCOMPLETE" | "UNAVAILABLE";
export type Phase7CPerformanceManagementEvidence = "EXACT" | "AMBIGUOUS" | "UNMATCHED";

export interface Phase7CPerformanceMetricBucket {
  key: string;
  sampleSize: number;
  wins: number;
  losses: number;
  breakeven: number;
  netPnl: number;
  expectancy: number;
  winRatePercent: number;
  profitFactor: number | null;
}

export interface Phase7CPerformanceEffectivenessSnapshot {
  schemaVersion: "phase7c-performance-effectiveness-v1";
  generatedAt: number;
  source: "PHASE7C_PERFORMANCE_EFFECTIVENESS";
  readOnly: true;
  safety: {
    readOnly: true;
    runtimeMutation: false;
    strategyMutation: false;
    riskMutation: false;
    orderMutation: false;
    positionMutation: false;
    modeMutation: false;
    armMutation: false;
    autoRetune: false;
    liveTestOrder: false;
  };
  summary: {
    totalRows: number;
    exactRows: number;
    excursionQualifiedRows: number;
    managementQualifiedRows: number;
    evidenceCoveragePercent: number;
  };
  aggregates: {
    strategy: Phase7CPerformanceMetricBucket[];
    entryType: Phase7CPerformanceMetricBucket[];
    regime: Phase7CPerformanceMetricBucket[];
    rule: Phase7CPerformanceMetricBucket[];
    management: Phase7CPerformanceMetricBucket[];
    excursion: {
      sampleSize: number;
      averageMfePrice: number | null;
      averageMaePrice: number | null;
      averageMfeR: number | null;
      averageMaeR: number | null;
      averageRealizedR: number | null;
      averagePeakToExitGivebackPrice: number | null;
    };
    fastMove: {
      exactSampleSize: number;
      triggeredRows: number;
      handoffRows: number;
      averageLockedProfitPrice: number | null;
    };
  };
  rows: Array<{
    schemaVersion: "phase7c-performance-effectiveness-v1";
    tradeKey: string;
    positionId: string;
    symbol: string;
    accountMode: "DEMO" | "LIVE";
    strategy: Phase7CPerformanceStrategy;
    side: Phase7CPerformanceSide;
    entryType: Phase7CPerformanceEntryType;
    regime: string | null;
    openedAt: number;
    closedAt: number;
    entry: number;
    exit: number;
    initialVolume: number;
    netPnl: number;
    correlation: {
      verdict: Phase7CPerformanceCorrelationVerdict;
      evidence: string[];
    };
    rules: {
      passed: string[];
      blocked: string[];
    };
    excursion: {
      evidence: Phase7CPerformanceExcursionEvidence;
      initialRiskPrice: number | null;
      mfePrice: number | null;
      maePrice: number | null;
      mfeR: number | null;
      maeR: number | null;
      realizedR: number | null;
      peakToExitGivebackPrice: number | null;
    };
    management: {
      evidence: Phase7CPerformanceManagementEvidence;
      events: Array<{
        family: string;
        timestamp: number;
        stopLoss: number | null;
        price: number | null;
        source: string;
        eventId: string;
      }>;
    };
    fastMove: {
      current: {
        activationPrice: number;
        givebackPrice: number;
        source: "LIVE_BID_ASK";
      };
      triggered: boolean;
      handoffToM5: boolean;
    };
    quality: {
      exactCorrelation: boolean;
      completeExcursionEvidence: boolean;
      exactManagementEvidence: boolean;
      warnings: string[];
    };
  }>;
  notes: string[];
}
