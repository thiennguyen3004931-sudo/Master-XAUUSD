import { TradingSession } from "@xauusd/types";
import type { StrategyEngineConfig } from "../config";
import type { IStrategyRule } from "../contracts";
import type { StrategyContext, StrategyEvaluationDraft, StrategyRuleResult } from "../models";

export class SessionRule implements IStrategyRule {
  readonly name = "session";
  evaluate(_context: StrategyContext, draft: StrategyEvaluationDraft, config: StrategyEngineConfig): StrategyRuleResult {
    const globallyAllowed = config.allowedSessions.includes(draft.session);
    const candidateAllowed = draft.selection.selected?.supportedSessions.includes(draft.session) ?? false;
    const asianException =
      draft.session === TradingSession.ASIAN &&
      draft.selection.selected?.strategyId === "RANGE_MEAN_REVERSION" &&
      config.allowAsianRangeMeanReversion;
    const passed = globallyAllowed && (candidateAllowed || asianException);
    return {
      rule: this.name,
      passed,
      actionOnFailure: "WAIT",
      code: passed ? undefined : "SESSION_NOT_ALLOWED",
      message: passed ? "The selected strategy is allowed in the active session." : "The active session does not allow the selected strategy.",
      metrics: { session: draft.session },
    };
  }
}
