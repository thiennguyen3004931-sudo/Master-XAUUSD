import { SignalType } from "@xauusd/types";
import type { RiskEngineConfig } from "../config";
import type { IRiskRule } from "../contracts";
import type {
  RiskContext,
  RiskEvaluationDraft,
  RiskRuleResult,
} from "../models";

export class LevelIntegrityRule implements IRiskRule {
  readonly name = "level-integrity";

  evaluate(
    _context: RiskContext,
    draft: RiskEvaluationDraft,
    _config: RiskEngineConfig,
  ): RiskRuleResult {
    const signal = draft.signal;
    const levels = draft.levels;

    const buyValid =
      signal?.type === SignalType.BUY &&
      levels !== null &&
      levels.stopLoss < levels.entry &&
      levels.takeProfit > levels.entry;

    const sellValid =
      signal?.type === SignalType.SELL &&
      levels !== null &&
      levels.stopLoss > levels.entry &&
      levels.takeProfit < levels.entry;

    const passed =
      (buyValid || sellValid) &&
      levels !== null &&
      levels.riskDistance > 0 &&
      levels.rewardDistance > 0 &&
      Number.isFinite(levels.riskReward);

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "INVALID_LEVELS",
      message: passed
        ? "Entry, stop loss and take profit are directionally valid."
        : "Signal levels are missing, non-finite or directionally invalid.",
    };
  }
}
