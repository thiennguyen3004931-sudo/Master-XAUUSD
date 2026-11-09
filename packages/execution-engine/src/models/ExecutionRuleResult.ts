import type { ExecutionRejectionCode } from "./ExecutionDiagnostics";

export interface ExecutionRuleResult {
  rule: string;
  passed: boolean;
  code?: ExecutionRejectionCode;
  message: string;
  metrics?: Readonly<Record<string, number | string | boolean>>;
}
