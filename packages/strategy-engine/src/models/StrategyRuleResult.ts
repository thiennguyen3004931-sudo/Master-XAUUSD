import type { StrategyRejectionCode } from "./StrategyDiagnostics";

export interface StrategyRuleResult {
  rule: string;
  passed: boolean;
  actionOnFailure: "WAIT" | "REJECT";
  code?: StrategyRejectionCode;
  message: string;
  metrics?: Readonly<Record<string, number | string | boolean>>;
}
