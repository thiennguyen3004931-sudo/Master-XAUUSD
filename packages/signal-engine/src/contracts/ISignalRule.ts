import type { SignalEngineConfig } from "../config";
import type { SignalContext, SignalRuleResult } from "../models";

export interface ISignalRule {
  readonly name: string;
  evaluate(
    context: SignalContext,
    config: SignalEngineConfig,
  ): SignalRuleResult;
}
