import type { RiskEngineConfig } from "../config";
import type { IRiskRule } from "../contracts";
import type {
  RiskContext,
  RiskEvaluationDraft,
  RiskRuleResult,
} from "../models";
import { NumberUtils } from "../utils";

export class DailyLossRule implements IRiskRule {
  readonly name = "daily-loss";

  evaluate(
    context: RiskContext,
    _draft: RiskEvaluationDraft,
    config: RiskEngineConfig,
  ): RiskRuleResult {
    const dailyPnl =
      context.portfolio.dailyRealizedPnl +
      (context.portfolio.dailyUnrealizedPnl ?? 0);
    const dailyLossPercent =
      dailyPnl < 0
        ? Math.abs(NumberUtils.percentOf(dailyPnl, context.account.balance))
        : 0;
    const passed = dailyLossPercent < config.maxDailyLossPercent;

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "DAILY_LOSS_LIMIT_REACHED",
      message: passed
        ? "Daily loss remains below the configured limit."
        : "Daily loss limit has been reached.",
      metrics: {
        dailyPnl,
        dailyLossPercent,
        maximumDailyLossPercent: config.maxDailyLossPercent,
      },
    };
  }
}
