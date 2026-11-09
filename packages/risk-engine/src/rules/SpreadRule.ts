import type { RiskEngineConfig } from "../config";
import type { IRiskRule } from "../contracts";
import type {
  RiskContext,
  RiskEvaluationDraft,
  RiskRuleResult,
} from "../models";

export class SpreadRule implements IRiskRule {
  readonly name = "spread";

  evaluate(
    context: RiskContext,
    _draft: RiskEvaluationDraft,
    config: RiskEngineConfig,
  ): RiskRuleResult {
    const maximumSpread =
      context.instrument.maxSpread * config.maximumSpreadMultiplier;
    const passed =
      Number.isFinite(context.portfolio.spread) &&
      context.portfolio.spread >= 0 &&
      context.portfolio.spread <= maximumSpread;

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "SPREAD_TOO_HIGH",
      message: passed
        ? "Current spread is within the instrument limit."
        : "Current spread exceeds the permitted instrument limit.",
      metrics: {
        spread: context.portfolio.spread,
        maximumSpread,
      },
    };
  }
}
