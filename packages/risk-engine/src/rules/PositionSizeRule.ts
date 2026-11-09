import type { RiskEngineConfig } from "../config";
import type { IRiskRule } from "../contracts";
import type {
  RiskContext,
  RiskEvaluationDraft,
  RiskRuleResult,
} from "../models";

export class PositionSizeRule implements IRiskRule {
  readonly name = "position-size";

  evaluate(
    context: RiskContext,
    draft: RiskEvaluationDraft,
    config: RiskEngineConfig,
  ): RiskRuleResult {
    const sizing = draft.sizing;
    const budget = draft.budget;

    if (!sizing || !budget) {
      return {
        rule: this.name,
        passed: false,
        code: "POSITION_SIZE_INVALID",
        message: "Position sizing could not be calculated.",
      };
    }

    if (sizing.belowMinimum) {
      return {
        rule: this.name,
        passed: false,
        code: "POSITION_SIZE_BELOW_MINIMUM",
        message:
          "Calculated volume is below the instrument minimum and would exceed the risk budget if rounded up.",
        metrics: {
          rawVolume: sizing.rawVolume,
          minimumVolume: context.instrument.minVolume,
        },
      };
    }

    const tolerance =
      1 + config.sizeRoundingTolerancePercent / 100;
    const withinBudget =
      sizing.actualRiskAmount <= budget.approvedRiskAmount * tolerance;
    const validStep =
      sizing.volume >= context.instrument.minVolume &&
      sizing.volume <= context.instrument.maxVolume &&
      sizing.volume > 0;
    const passed =
      Number.isFinite(sizing.volume) && validStep && withinBudget;

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "POSITION_SIZE_INVALID",
      message: passed
        ? "Position size is valid and remains within the approved risk budget."
        : "Position size is invalid or exceeds the approved risk budget.",
      metrics: {
        volume: sizing.volume,
        actualRiskAmount: sizing.actualRiskAmount,
        approvedRiskAmount: budget.approvedRiskAmount,
      },
    };
  }
}
