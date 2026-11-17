import { TradeDecision } from "@xauusd/types";
import type { IRiskRule } from "../contracts";
import type {
  RiskContext,
  RiskEvaluationDraft,
  RiskRuleResult,
} from "../models";
import type { RiskEngineConfig } from "../config";

export class SignalAcceptanceRule implements IRiskRule {
  readonly name = "signal-acceptance";

  evaluate(
    context: RiskContext,
    draft: RiskEvaluationDraft,
    _config: RiskEngineConfig,
  ): RiskRuleResult {
    const passed =
      context.signalResult.decision !== TradeDecision.WAIT &&
      context.signalResult.diagnostics.accepted &&
      draft.signal !== null &&
      draft.levels !== null;

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "SIGNAL_NOT_ACCEPTED",
      message: passed
        ? "Signal was accepted by the signal engine."
        : "Signal engine did not provide an accepted BUY or SELL signal.",
    };
  }
}
