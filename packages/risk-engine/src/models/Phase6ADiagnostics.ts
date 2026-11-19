import type { Phase6Side } from "./Phase6TrendEngulfing";

export interface Phase6ADiagnosticMetrics {
  cases: number;
  filledTrades: number;
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
  maxRealizedDrawdownUsd: number;
  averageHoldHours: number;
}

export type Phase6AConfluenceKey =
  | "MA_FVG"
  | "MA_VOLUME_PROFILE"
  | "FVG_VOLUME_PROFILE"
  | "MA_FVG_VOLUME_PROFILE"
  | "OTHER";

export type Phase6ARescueSource =
  | "M5_MA20"
  | "M5_MA50"
  | "M5_FVG"
  | "M15_POC"
  | "M15_VAH"
  | "M15_VAL";

export interface Phase6ARiskBlockedSetup {
  id: string;
  side: Phase6Side;
  signalTimestamp: number;
  canonicalEntry: number;
  stopLoss: number;
  requiredRiskAtMinVolumeUsd: number;
  maPullback: boolean;
  fvg: boolean;
  volumeProfile: boolean;
  profile: { poc: number; vah: number; val: number } | null;
}

export interface Phase6ARescueCase extends Phase6ARiskBlockedSetup {
  rescued: boolean;
  rescueSource: Phase6ARescueSource | null;
  rescueEntry: number | null;
  rescueRiskUsd: number | null;
  rescueFillTime: number | null;
}

export interface Phase6AWalkForwardFold {
  fold: number;
  startTimestamp: number | null;
  endTimestamp: number | null;
  metrics: Phase6ADiagnosticMetrics;
  positive: boolean;
}

export interface Phase6ADiagnosticsResult {
  side: Record<Phase6Side, Phase6ADiagnosticMetrics>;
  confluence: Record<Phase6AConfluenceKey, Phase6ADiagnosticMetrics>;
  riskBlockedSetups: Phase6ARiskBlockedSetup[];
  rescueCases: Phase6ARescueCase[];
  riskBlockedCount: number;
  rescuedCount: number;
  rescueRatePercent: number;
  rescueSourceCounts: Record<Phase6ARescueSource, number>;
  walkForwardFolds: Phase6AWalkForwardFold[];
  positiveFolds: number;
}
