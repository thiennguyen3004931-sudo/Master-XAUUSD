import type { StrategyEngineConfig } from "../config";
import type { IStrategyRule } from "../contracts";
import type { StrategyContext, StrategyEvaluationDraft, StrategyRuleResult } from "../models";

export class OrderPresenceRule implements IStrategyRule {
  readonly name = "order-presence";
  evaluate(context: StrategyContext, _draft: StrategyEvaluationDraft, _config: StrategyEngineConfig): StrategyRuleResult {
    const passed = context.riskAssessment.order !== null;
    return {
      rule: this.name,
      passed,
      actionOnFailure: "REJECT",
      code: passed ? undefined : "ORDER_MISSING",
      message: passed ? "Risk assessment contains a normalized order candidate." : "Risk assessment did not contain an order candidate.",
    };
  }
}
