export type ExecutionStatus =
  | "PENDING_PREFLIGHT"
  | "REJECTED"
  | "SUBMITTING"
  | "FILLED"
  | "PARTIALLY_FILLED"
  | "CANCELLED"
  | "FAILED"
  | "CLOSED";
