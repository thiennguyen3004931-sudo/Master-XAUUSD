import type { RiskEngineConfig } from "../config";
import type { IRiskRule } from "../contracts";
import type {
  RiskContext,
  RiskEvaluationDraft,
  RiskRuleResult,
} from "../models";

export class ExposureRule implements IRiskRule {
  readonly name = "portfolio-exposure";

  evaluate(
    _context: RiskContext,
    draft: RiskEvaluationDraft,
    config: RiskEngineConfig,
  ): RiskRuleResult {
    const projectedPercent =
      draft.exposure?.projectedOpenRiskPercent ??
      Number.POSITIVE_INFINITY;
    const passed =
      Number.isFinite(projectedPercent) &&
      projectedPercent <= config.maxTotalOpenRiskPercent;

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "TOTAL_EXPOSURE_LIMIT_REACHED",
      message: passed
        ? "Projected portfolio risk remains within the configured limit."
        : "Projected portfolio risk exceeds the configured limit.",
      metrics: {
        projectedOpenRiskPercent: projectedPercent,
        maximumOpenRiskPercent: config.maxTotalOpenRiskPercent,
      },
    };
  }
}
