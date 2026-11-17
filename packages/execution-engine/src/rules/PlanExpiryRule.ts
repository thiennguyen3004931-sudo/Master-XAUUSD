import type { ExecutionEngineConfig } from "../config";
import type { IExecutionRule } from "../contracts";
import type {
  ExecutionPreflightDraft,
  ExecutionRequest,
  ExecutionRuleResult,
} from "../models";

export class PlanExpiryRule implements IExecutionRule {
  readonly name = "plan-expiry";

  evaluate(
    _request: ExecutionRequest,
    draft: ExecutionPreflightDraft,
    config: ExecutionEngineConfig,
  ): ExecutionRuleResult {
    const expiresAt = draft.plan?.expiresAt ?? 0;
    const passed =
      draft.plan !== null &&
      draft.evaluatedAt <= expiresAt + config.planExpiryGraceMs;

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "PLAN_EXPIRED",
      message: passed
        ? "Strategy plan remains valid."
        : "Strategy plan has expired.",
      metrics: {
        evaluatedAt: draft.evaluatedAt,
        expiresAt,
      },
    };
  }
}
