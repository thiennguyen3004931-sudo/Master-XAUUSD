import type { StrategyEngineConfig } from "../config";
import type { IStrategyRule } from "../contracts";
import type { StrategyContext, StrategyEvaluationDraft, StrategyRuleResult } from "../models";

export class RiskApprovalRule implements IStrategyRule {
  readonly name = "risk-approval";
  evaluate(context: StrategyContext, _draft: StrategyEvaluationDraft, config: StrategyEngineConfig): StrategyRuleResult {
    const passed = !config.requireRiskApproval || (
      context.riskAssessment.approved &&
      context.riskAssessment.order !== null
    );
    return {
      rule: this.name,
      passed,
      actionOnFailure: "REJECT",
      code: passed ? undefined : "RISK_NOT_APPROVED",
      message: passed ? "Risk engine approved an executable order candidate." : "Risk engine rejected the trade or did not produce an order.",
    };
  }
}
