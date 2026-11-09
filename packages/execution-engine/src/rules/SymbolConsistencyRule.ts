import type { ExecutionEngineConfig } from "../config";
import type { IExecutionRule } from "../contracts";
import type {
  ExecutionPreflightDraft,
  ExecutionRequest,
  ExecutionRuleResult,
} from "../models";

export class SymbolConsistencyRule implements IExecutionRule {
  readonly name = "symbol-consistency";

  evaluate(
    _request: ExecutionRequest,
    draft: ExecutionPreflightDraft,
    _config: ExecutionEngineConfig,
  ): ExecutionRuleResult {
    const symbol = draft.normalizedOrder?.symbol;
    const passed =
      symbol !== undefined &&
      draft.quote?.symbol === symbol &&
      draft.spec?.symbol === symbol;

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "SYMBOL_MISMATCH",
      message: passed
        ? "Order, quote and symbol specification match."
        : "Order, quote or symbol specification symbols differ.",
    };
  }
}
