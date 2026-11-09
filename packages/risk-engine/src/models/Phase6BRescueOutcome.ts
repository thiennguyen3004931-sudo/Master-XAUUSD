import type { Phase6ADiagnosticMetrics, Phase6ARescueSource } from "./Phase6ADiagnostics";
import type { Phase6Side } from "./Phase6TrendEngulfing";

export type Phase6BExitReason = "STOP" | "TREND_MA20" | "END_OF_DATA";

export interface Phase6BRescuedTrade {
  id: string;
  side: Phase6Side;
  signalTimestamp: number;
  rescueSource: Phase6ARescueSource;
  entry: number;
  stopLoss: number;
  volume: number;
  initialRiskUsd: number;
  entryTime: number;
  exitTime: number;
  exit: number;
  finalStopLoss: number;
  pnl: number;
  rMultiple: number;
  holdHours: number;
  reachedPlus6: boolean;
  reachedPlus10: boolean;
  breakEvenApplied: boolean;
  trailingActivated: boolean;
  exitReason: Phase6BExitReason;
}

export interface Phase6BSideFold {
  side: Phase6Side;
  fold: number;
  startTimestamp: number | null;
  endTimestamp: number | null;
  metrics: Phase6ADiagnosticMetrics;
  positive: boolean;
}

export interface Phase6BRescueOutcomeResult {
  rescuedTrades: Phase6BRescuedTrade[];
  rescuedMetrics: Phase6ADiagnosticMetrics;
  rescuedBySide: Record<Phase6Side, Phase6ADiagnosticMetrics>;
  rescuedBySource: Record<Phase6ARescueSource, Phase6ADiagnosticMetrics>;
  combinedMetrics: Phase6ADiagnosticMetrics;
  combinedBySide: Record<Phase6Side, Phase6ADiagnosticMetrics>;
  baselineSideFolds: Record<Phase6Side, Phase6BSideFold[]>;
  baselinePositiveSideFolds: Record<Phase6Side, number>;
  combinedSideFolds: Record<Phase6Side, Phase6BSideFold[]>;
  combinedPositiveSideFolds: Record<Phase6Side, number>;
}
