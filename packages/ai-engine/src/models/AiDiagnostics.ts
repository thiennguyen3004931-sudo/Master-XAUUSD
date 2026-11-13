export type AiRejectionCode =
  | "STRATEGY_NOT_EXECUTABLE"
  | "RISK_NOT_APPROVED"
  | "CONTEXT_STALE"
  | "SYMBOL_MISMATCH"
  | "PROVIDER_COUNT_TOO_LOW"
  | "PROVIDER_AGREEMENT_TOO_LOW"
  | "OPINION_CONFIDENCE_TOO_LOW"
  | "ALL_PROVIDERS_FAILED"
  | "MALFORMED_PROVIDER_RESPONSE"
  | "POLICY_DOWNGRADE"
  | "POLICY_REJECTION";

export interface AiDiagnostics {
  accepted: boolean;
  rejectionCodes: AiRejectionCode[];
  warnings: string[];
  notes: string[];
}
