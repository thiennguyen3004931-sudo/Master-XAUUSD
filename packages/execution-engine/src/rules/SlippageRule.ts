import type { ExecutionEngineConfig } from "../config";
import type { IExecutionRule } from "../contracts";
import type {
  ExecutionPreflightDraft,
  ExecutionRequest,
  ExecutionRuleResult,
} from "../models";

export class SlippageRule implements IExecutionRule {
  readonly name = "slippage";

  evaluate(
    _request: ExecutionRequest,
    draft: ExecutionPreflightDraft,
    config: ExecutionEngineConfig,
  ): ExecutionRuleResult {
    const ticks =
      draft.slippage?.slippageTicks ??
      Number.POSITIVE_INFINITY;
    const passed =
      draft.slippage?.favorable === true ||
      (Number.isFinite(ticks) &&
        ticks <= config.maxSlippageTicks);

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "SLIPPAGE_TOO_HIGH",
      message: passed
        ? "Expected execution slippage is acceptable."
        : "Expected execution slippage exceeds the configured limit.",
      metrics: {
        slippageTicks: ticks,
        maximumSlippageTicks: config.maxSlippageTicks,
        favorable: draft.slippage?.favorable ?? false,
      },
    };
  }
}
