export const PHASE7C_PERFORMANCE_EFFECTIVENESS_SCHEMA_VERSION =
  "phase7c-performance-effectiveness-v1" as const;

export type Phase7CPerformanceStrategy = "TREND" | "SIDEWAY" | "REVERSAL";
export type Phase7CPerformanceSide = "BUY" | "SELL";
export type Phase7CPerformanceEntryType = "IMMEDIATE" | "PULLBACK" | "RECOVERY" | "UNKNOWN";
export type Phase7CPerformanceCorrelationVerdict = "EXACT" | "AMBIGUOUS" | "UNMATCHED";
export type Phase7CPerformanceExcursionEvidence =
  | "COMPLETE_M5_WINDOW"
  | "INCOMPLETE"
  | "UNAVAILABLE";
export type Phase7CPerformanceManagementEvidence = "EXACT" | "AMBIGUOUS" | "UNMATCHED";

export type Phase7CPerformanceManagementFamily =
  | "BREAK_EVEN"
  | "PARTIAL_CLOSE"
  | "FAST_MOVE_TIGHTEN"
  | "FAST_MOVE_REJECTED"
  | "FAST_MOVE_HANDOFF_M5_STRUCTURE"
  | "M5_STRUCTURAL_TIGHTEN"
  | "M5_STRUCTURAL_REJECTED"
  | "FIXED_TP_CLOSE"
  | "RECOVERY_TP_CLOSE"
  | "REVERSAL_CLOSE"
  | "OTHER_CLOSE";

export interface Phase7CPerformanceExcursion {
  evidence: Phase7CPerformanceExcursionEvidence;
  initialRiskPrice: number | null;
  mfePrice: number | null;
  maePrice: number | null;
  mfeR: number | null;
  maeR: number | null;
  realizedR: number | null;
  peakToExitGivebackPrice: number | null;
}

export interface Phase7CPerformanceManagementEvent {
  family: Phase7CPerformanceManagementFamily;
  timestamp: number;
  stopLoss: number | null;
  price: number | null;
  favorablePrice: number | null;
  closedVolume: number | null;
  remainingVolume: number | null;
  source: string;
  eventId: string;
}

export interface Phase7CPerformanceFastMoveContract {
  activationPrice: number;
  givebackPrice: number;
  source: "LIVE_BID_ASK";
}

export interface Phase7CPerformanceEffectivenessRow {
  schemaVersion: typeof PHASE7C_PERFORMANCE_EFFECTIVENESS_SCHEMA_VERSION;
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
  excursion: Phase7CPerformanceExcursion;
  management: {
    evidence: Phase7CPerformanceManagementEvidence;
    events: Phase7CPerformanceManagementEvent[];
  };
  fastMove: {
    current: Phase7CPerformanceFastMoveContract;
    triggered: boolean;
    handoffToM5: boolean;
  };
  quality: {
    exactCorrelation: boolean;
    completeExcursionEvidence: boolean;
    exactManagementEvidence: boolean;
    warnings: string[];
  };
}

export interface Phase7CPerformanceEffectivenessMetricBucket {
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

export interface Phase7CPerformanceEffectivenessExcursionAggregate {
  sampleSize: number;
  averageMfePrice: number | null;
  averageMaePrice: number | null;
  averageMfeR: number | null;
  averageMaeR: number | null;
  averageRealizedR: number | null;
  averagePeakToExitGivebackPrice: number | null;
}

export interface Phase7CPerformanceEffectivenessFastMoveAggregate {
  exactSampleSize: number;
  triggeredRows: number;
  handoffRows: number;
  averageLockedProfitPrice: number | null;
}

export interface Phase7CPerformanceEffectivenessAggregates {
  strategy: Phase7CPerformanceEffectivenessMetricBucket[];
  entryType: Phase7CPerformanceEffectivenessMetricBucket[];
  regime: Phase7CPerformanceEffectivenessMetricBucket[];
  rule: Phase7CPerformanceEffectivenessMetricBucket[];
  management: Phase7CPerformanceEffectivenessMetricBucket[];
  excursion: Phase7CPerformanceEffectivenessExcursionAggregate;
  fastMove: Phase7CPerformanceEffectivenessFastMoveAggregate;
}

export interface Phase7CPerformanceEffectivenessSnapshot {
  schemaVersion: typeof PHASE7C_PERFORMANCE_EFFECTIVENESS_SCHEMA_VERSION;
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
  aggregates: Phase7CPerformanceEffectivenessAggregates;
  rows: Phase7CPerformanceEffectivenessRow[];
  notes: string[];
}
