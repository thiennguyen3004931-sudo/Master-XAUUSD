import type { RiskEngineConfig } from "../config";
import type { IRiskRule } from "../contracts";
import type {
  RiskContext,
  RiskEvaluationDraft,
  RiskRuleResult,
} from "../models";

export class RiskRewardRule implements IRiskRule {
  readonly name = "risk-reward";

  evaluate(
    _context: RiskContext,
    draft: RiskEvaluationDraft,
    config: RiskEngineConfig,
  ): RiskRuleResult {
    const riskReward = draft.levels?.riskReward ?? 0;
    const passed =
      Number.isFinite(riskReward) &&
      riskReward >= config.minimumRiskReward;

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "RISK_REWARD_TOO_LOW",
      message: passed
        ? "Risk-to-reward ratio meets the configured minimum."
        : "Risk-to-reward ratio is below the configured minimum.",
      metrics: {
        riskReward,
        minimumRiskReward: config.minimumRiskReward,
      },
    };
  }
}
