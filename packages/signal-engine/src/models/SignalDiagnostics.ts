export type SignalRejectionCode =
  | "NO_DIRECTION"
  | "INDICATOR_WARMUP_INCOMPLETE"
  | "ANALYSIS_SCORE_TOO_LOW"
  | "DATA_QUALITY_TOO_LOW"
  | "VOLATILITY_TOO_LOW"
  | "VOLATILITY_TOO_HIGH"
  | "CONFIDENCE_TOO_LOW"
  | "DIRECTIONAL_EDGE_TOO_LOW"
  | "INVALID_LEVEL_PLAN"
  | "TREND_STRUCTURE_ALIGNMENT_REQUIRED"
  | "PULLBACK_ZONE_REQUIRED";

export interface SignalDiagnostics {
  accepted: boolean;
  rejectionCodes: SignalRejectionCode[];
  notes: string[];
}
