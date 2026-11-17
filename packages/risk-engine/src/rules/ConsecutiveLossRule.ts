import type { RiskEngineConfig } from "../config";
import type { IRiskRule } from "../contracts";
import type {
  RiskContext,
  RiskEvaluationDraft,
  RiskRuleResult,
} from "../models";

export class ConsecutiveLossRule implements IRiskRule {
  readonly name = "consecutive-losses";

  evaluate(
    context: RiskContext,
    _draft: RiskEvaluationDraft,
    config: RiskEngineConfig,
  ): RiskRuleResult {
    const passed =
      context.portfolio.consecutiveLosses <
      config.maxConsecutiveLosses;

    return {
      rule: this.name,
      passed,
      code: passed
        ? undefined
        : "CONSECUTIVE_LOSS_LIMIT_REACHED",
      message: passed
        ? "Consecutive loss count is below the configured limit."
        : "Maximum consecutive loss count has been reached.",
      metrics: {
        consecutiveLosses: context.portfolio.consecutiveLosses,
        maximumConsecutiveLosses: config.maxConsecutiveLosses,
      },
    };
  }
}
