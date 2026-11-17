import type { RiskEngineConfig } from "../config";
import type { IRiskRule } from "../contracts";
import type {
  RiskContext,
  RiskEvaluationDraft,
  RiskRuleResult,
} from "../models";

export class CooldownRule implements IRiskRule {
  readonly name = "loss-cooldown";

  evaluate(
    context: RiskContext,
    _draft: RiskEvaluationDraft,
    config: RiskEngineConfig,
  ): RiskRuleResult {
    const lastClosedAt = context.portfolio.lastTradeClosedAt;
    if (
      context.portfolio.consecutiveLosses <= 0 ||
      lastClosedAt === undefined
    ) {
      return {
        rule: this.name,
        passed: true,
        message: "No loss cooldown is active.",
      };
    }

    const evaluatedAt = context.evaluatedAt ?? Date.now();
    const elapsedMinutes = Math.max(
      0,
      (evaluatedAt - lastClosedAt) / 60_000,
    );
    const passed = elapsedMinutes >= config.cooldownAfterLossMinutes;

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "LOSS_COOLDOWN_ACTIVE",
      message: passed
        ? "Loss cooldown period has expired."
        : "A cooldown period is active after the latest losing trade.",
      metrics: {
        elapsedMinutes,
        requiredCooldownMinutes: config.cooldownAfterLossMinutes,
      },
    };
  }
}
