import type { ExecutionResult } from "@xauusd/types";
import type { ExecutionAction } from "./ExecutionAction";
import type { ExecutionDiagnostics } from "./ExecutionDiagnostics";
import type { ExecutionRecord } from "./ExecutionRecord";
import type { ExecutionRuleResult } from "./ExecutionRuleResult";

export interface ExecutionEngineResult {
  success: boolean;
  action: ExecutionAction;
  record: ExecutionRecord | null;
  rules: ExecutionRuleResult[];
  diagnostics: ExecutionDiagnostics;
  commonResult: ExecutionResult;
  generatedAt: number;
}
