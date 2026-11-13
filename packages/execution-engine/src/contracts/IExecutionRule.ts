import type { ExecutionEngineConfig } from "../config";
import type {
  ExecutionPreflightDraft,
  ExecutionRequest,
  ExecutionRuleResult,
} from "../models";

export interface IExecutionRule {
  readonly name: string;

  evaluate(
    request: ExecutionRequest,
    draft: ExecutionPreflightDraft,
    config: ExecutionEngineConfig,
  ): ExecutionRuleResult;
}
