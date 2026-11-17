import type { ExecutionEngineConfig } from "../config";
import type { IExecutionRule } from "../contracts";
import type {
  ExecutionPreflightDraft,
  ExecutionRequest,
  ExecutionRuleResult,
} from "../models";

export class DuplicateRequestRule implements IExecutionRule {
  readonly name = "duplicate-request";

  evaluate(
    _request: ExecutionRequest,
    draft: ExecutionPreflightDraft,
    _config: ExecutionEngineConfig,
  ): ExecutionRuleResult {
    return {
      rule: this.name,
      passed: !draft.duplicate,
      code: draft.duplicate
        ? "DUPLICATE_REQUEST"
        : undefined,
      message: draft.duplicate
        ? "An execution already exists for this idempotency key."
        : "Execution request is unique.",
    };
  }
}
