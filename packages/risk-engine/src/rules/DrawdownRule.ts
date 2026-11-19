import type { RiskEngineConfig } from "../config";
import type { IRiskRule } from "../contracts";
import type {
  RiskContext,
  RiskEvaluationDraft,
  RiskRuleResult,
} from "../models";
import { NumberUtils } from "../utils";

export class DrawdownRule implements IRiskRule {
  readonly name = "drawdown";

  evaluate(
    context: RiskContext,
    _draft: RiskEvaluationDraft,
    config: RiskEngineConfig,
  ): RiskRuleResult {
    const drawdownPercent =
      context.portfolio.peakEquity > 0
        ? Math.max(
            0,
            NumberUtils.percentOf(
              context.portfolio.peakEquity - context.account.equity,
              context.portfolio.peakEquity,
            ),
          )
        : 0;
    const passed = drawdownPercent < config.maxDrawdownPercent;

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "DRAWDOWN_LIMIT_REACHED",
      message: passed
        ? "Account drawdown remains below the configured limit."
        : "Maximum account drawdown has been reached.",
      metrics: {
        drawdownPercent,
        maximumDrawdownPercent: config.maxDrawdownPercent,
      },
    };
  }
}
