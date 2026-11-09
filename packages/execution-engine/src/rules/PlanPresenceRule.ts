import type { ExecutionEngineConfig } from "../config";
import type { IExecutionRule } from "../contracts";
import type {
  ExecutionPreflightDraft,
  ExecutionRequest,
  ExecutionRuleResult,
} from "../models";

export class PlanPresenceRule implements IExecutionRule {
  readonly name = "plan-presence";

  evaluate(
    _request: ExecutionRequest,
    draft: ExecutionPreflightDraft,
    _config: ExecutionEngineConfig,
  ): ExecutionRuleResult {
    const passed = draft.plan !== null;

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "PLAN_MISSING",
      message: passed
        ? "Strategy execution plan is present."
        : "Strategy execution plan is missing.",
    };
  }
}
