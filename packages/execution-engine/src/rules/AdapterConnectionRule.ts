import type { ExecutionEngineConfig } from "../config";
import type { IExecutionRule } from "../contracts";
import type {
  ExecutionPreflightDraft,
  ExecutionRequest,
  ExecutionRuleResult,
} from "../models";

export class AdapterConnectionRule implements IExecutionRule {
  readonly name = "adapter-connection";

  evaluate(
    _request: ExecutionRequest,
    draft: ExecutionPreflightDraft,
    _config: ExecutionEngineConfig,
  ): ExecutionRuleResult {
    return {
      rule: this.name,
      passed: draft.adapterConnected,
      code: draft.adapterConnected
        ? undefined
        : "ADAPTER_DISCONNECTED",
      message: draft.adapterConnected
        ? "Execution adapter is connected."
        : "Execution adapter is disconnected.",
    };
  }
}
