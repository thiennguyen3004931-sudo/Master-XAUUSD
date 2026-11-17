import type { RiskEngineConfig } from "../config";
import type { IRiskRule } from "../contracts";
import type {
  RiskContext,
  RiskEvaluationDraft,
  RiskRuleResult,
} from "../models";

export class PositionLimitRule implements IRiskRule {
  readonly name = "position-limit";

  evaluate(
    _context: RiskContext,
    draft: RiskEvaluationDraft,
    config: RiskEngineConfig,
  ): RiskRuleResult {
    const exposure = draft.exposure;
    const totalPassed =
      exposure !== null &&
      exposure.openPositionCount < config.maxOpenPositions;
    const symbolPassed =
      exposure !== null &&
      exposure.symbolPositionCount < config.maxOpenPositionsPerSymbol;
    const passed = totalPassed && symbolPassed;

    return {
      rule: this.name,
      passed,
      code: !totalPassed
        ? "MAX_POSITIONS_REACHED"
        : !symbolPassed
          ? "MAX_SYMBOL_POSITIONS_REACHED"
          : undefined,
      message: passed
        ? "Open position limits allow another trade."
        : !totalPassed
          ? "Maximum total open positions has been reached."
          : "Maximum open positions for this symbol has been reached.",
      metrics: {
        openPositionCount: exposure?.openPositionCount ?? 0,
        symbolPositionCount: exposure?.symbolPositionCount ?? 0,
        maximumOpenPositions: config.maxOpenPositions,
        maximumSymbolPositions: config.maxOpenPositionsPerSymbol,
      },
    };
  }
}
