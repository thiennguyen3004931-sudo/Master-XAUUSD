import type { ExecutionEngineConfig } from "../config";
import type { IExecutionRule } from "../contracts";
import type {
  ExecutionPreflightDraft,
  ExecutionRequest,
  ExecutionRuleResult,
} from "../models";

export class RateLimitRule implements IExecutionRule {
  readonly name = "rate-limit";

  evaluate(
    _request: ExecutionRequest,
    draft: ExecutionPreflightDraft,
    config: ExecutionEngineConfig,
  ): ExecutionRuleResult {
    const passed =
      draft.recentExecutionCount <
      config.maxExecutionsPerMinute;

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "RATE_LIMIT_REACHED",
      message: passed
        ? "Execution request is within the rate limit."
        : "Execution rate limit has been reached.",
      metrics: {
        executionsInLastMinute: draft.recentExecutionCount,
        maximumExecutionsPerMinute:
          config.maxExecutionsPerMinute,
      },
    };
  }
}
