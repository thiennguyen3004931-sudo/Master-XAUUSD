import type { RiskEngineConfig } from "../config";
import type { IRiskRule } from "../contracts";
import type {
  RiskContext,
  RiskEvaluationDraft,
  RiskRuleResult,
} from "../models";

export class MarginRule implements IRiskRule {
  readonly name = "margin";

  evaluate(
    _context: RiskContext,
    draft: RiskEvaluationDraft,
    config: RiskEngineConfig,
  ): RiskRuleResult {
    const margin = draft.margin;
    const usagePassed =
      margin !== null &&
      Number.isFinite(margin.projectedMarginUsagePercent) &&
      margin.projectedMarginUsagePercent <=
        config.maxMarginUsagePercent;
    const freeMarginPassed =
      margin !== null &&
      Number.isFinite(margin.projectedFreeMarginPercent) &&
      margin.projectedFreeMarginPercent >=
        config.minProjectedFreeMarginPercent;
    const passed = usagePassed && freeMarginPassed;

    return {
      rule: this.name,
      passed,
      code: !usagePassed
        ? "MARGIN_LIMIT_REACHED"
        : !freeMarginPassed
          ? "FREE_MARGIN_TOO_LOW"
          : undefined,
      message: passed
        ? "Projected margin usage and free margin are acceptable."
        : !usagePassed
          ? "Projected margin usage exceeds the configured limit."
          : "Projected free margin is below the configured minimum.",
      metrics: {
        projectedMarginUsagePercent:
          margin?.projectedMarginUsagePercent ?? Number.POSITIVE_INFINITY,
        projectedFreeMarginPercent:
          margin?.projectedFreeMarginPercent ?? Number.NEGATIVE_INFINITY,
        maximumMarginUsagePercent: config.maxMarginUsagePercent,
        minimumFreeMarginPercent:
          config.minProjectedFreeMarginPercent,
      },
    };
  }
}
