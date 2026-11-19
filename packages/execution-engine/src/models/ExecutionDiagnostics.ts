export type ExecutionRejectionCode =
  | "STRATEGY_NOT_EXECUTABLE"
  | "PLAN_MISSING"
  | "PLAN_EXPIRED"
  | "ADAPTER_DISCONNECTED"
  | "SYMBOL_MISMATCH"
  | "QUOTE_STALE"
  | "SPREAD_TOO_HIGH"
  | "SLIPPAGE_TOO_HIGH"
  | "ORDER_INVALID"
  | "VOLUME_INVALID"
  | "STOPS_TOO_CLOSE"
  | "TARGET_TOO_CLOSE"
  | "DUPLICATE_REQUEST"
  | "RATE_LIMIT_REACHED"
  | "ADAPTER_REJECTED"
  | "ADAPTER_ERROR";

export interface ExecutionDiagnostics {
  accepted: boolean;
  rejectionCodes: ExecutionRejectionCode[];
  warnings: string[];
  notes: string[];
}
