import type { ISignalRule } from "../contracts";
import type { SignalEngineConfig } from "../config";
import type { SignalContext, SignalRuleResult } from "../models";
import { RuleResultFactory } from "../utils";

export class RsiRule implements ISignalRule {
  readonly name = "RsiRule";

  evaluate(context: SignalContext, config: SignalEngineConfig): SignalRuleResult {
    const weight = config.weights.rsi;
    const rsi = context.indicators.latest.rsi;

    if (rsi === null) {
      return RuleResultFactory.neutral(this.name, weight, "RSI is unavailable");
    }

    if (rsi >= 52 && rsi <= 72) {
      const strength = Math.min(1, 0.55 + (rsi - 52) / 40);
      return RuleResultFactory.create(this.name, weight, "BULLISH", strength, "RSI supports bullish momentum", { rsi });
    }

    if (rsi <= 48 && rsi >= 28) {
      const strength = Math.min(1, 0.55 + (48 - rsi) / 40);
      return RuleResultFactory.create(this.name, weight, "BEARISH", strength, "RSI supports bearish momentum", { rsi });
    }

    return RuleResultFactory.neutral(this.name, weight, "RSI is neutral or extended", { rsi });
  }
}
