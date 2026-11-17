import type { ExecutionEngineConfig } from "../config";
import type { IExecutionRule } from "../contracts";
import type {
  ExecutionPreflightDraft,
  ExecutionRequest,
  ExecutionRuleResult,
} from "../models";

export class StrategyExecutableRule implements IExecutionRule {
  readonly name = "strategy-executable";

  evaluate(
    request: ExecutionRequest,
    _draft: ExecutionPreflightDraft,
    _config: ExecutionEngineConfig,
  ): ExecutionRuleResult {
    const passed =
      request.strategyEvaluation.action === "EXECUTE";

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "STRATEGY_NOT_EXECUTABLE",
      message: passed
        ? "Strategy evaluation authorizes execution."
        : "Strategy evaluation did not return EXECUTE.",
    };
  }
}
