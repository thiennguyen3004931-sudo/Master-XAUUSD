import { TradeDecision } from "@xauusd/types";
import type { StrategyEngineConfig } from "../config";
import type { IStrategyRule } from "../contracts";
import type { StrategyContext, StrategyEvaluationDraft, StrategyRuleResult } from "../models";

export class SignalAcceptanceRule implements IStrategyRule {
  readonly name = "signal-acceptance";
  evaluate(context: StrategyContext, _draft: StrategyEvaluationDraft, _config: StrategyEngineConfig): StrategyRuleResult {
    const passed =
      context.signalResult.decision !== TradeDecision.WAIT &&
      context.signalResult.diagnostics.accepted &&
      context.signalResult.signal !== null;
    return {
      rule: this.name,
      passed,
      actionOnFailure: "WAIT",
      code: passed ? undefined : "SIGNAL_NOT_ACCEPTED",
      message: passed ? "Signal engine supplied an accepted directional signal." : "No accepted directional signal is available.",
    };
  }
}
