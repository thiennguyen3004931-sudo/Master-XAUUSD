export type StrategyRejectionCode =
  | "SIGNAL_NOT_ACCEPTED"
  | "RISK_NOT_APPROVED"
  | "CONTEXT_STALE"
  | "SESSION_NOT_ALLOWED"
  | "REGIME_CONFIDENCE_LOW"
  | "NO_ELIGIBLE_STRATEGY"
  | "STRATEGY_SCORE_TOO_LOW"
  | "STRATEGY_EDGE_TOO_LOW"
  | "ORDER_MISSING";

export interface StrategyDiagnostics {
  accepted: boolean;
  rejectionCodes: StrategyRejectionCode[];
  warnings: string[];
  notes: string[];
}
