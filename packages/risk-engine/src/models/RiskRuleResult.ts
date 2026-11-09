import type { RiskRejectionCode } from "./RiskDiagnostics";

export interface RiskRuleResult {
  rule: string;
  passed: boolean;
  code?: RiskRejectionCode;
  message: string;
  metrics?: Readonly<Record<string, number | string | boolean>>;
}
