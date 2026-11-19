import type { ExecutionEngineConfig } from "../config";
import type { IExecutionRule } from "../contracts";
import type {
  ExecutionPreflightDraft,
  ExecutionRequest,
  ExecutionRuleResult,
} from "../models";

export class SpreadRule implements IExecutionRule {
  readonly name = "spread";

  evaluate(
    _request: ExecutionRequest,
    draft: ExecutionPreflightDraft,
    config: ExecutionEngineConfig,
  ): ExecutionRuleResult {
    const maximumSpread =
      (draft.spec?.maxSpread ?? 0) *
      config.maxSpreadMultiplier;
    const spread = draft.quote?.spread ??
      Number.POSITIVE_INFINITY;
    const passed =
      Number.isFinite(spread) &&
      spread >= 0 &&
      spread <= maximumSpread;

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "SPREAD_TOO_HIGH",
      message: passed
        ? "Current spread is within the execution limit."
        : "Current spread exceeds the execution limit.",
      metrics: {
        spread,
        maximumSpread,
      },
    };
  }
}
