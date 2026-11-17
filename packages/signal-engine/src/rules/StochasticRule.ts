import type { ISignalRule } from "../contracts";
import type { SignalEngineConfig } from "../config";
import type { SignalContext, SignalRuleResult } from "../models";
import { RuleResultFactory } from "../utils";

export class StochasticRule implements ISignalRule {
  readonly name = "StochasticRule";

  evaluate(context: SignalContext, config: SignalEngineConfig): SignalRuleResult {
    const weight = config.weights.stochastic;
    const { k, d } = context.indicators.latest.stochastic;

    if (k === null || d === null) {
      return RuleResultFactory.neutral(this.name, weight, "Stochastic oscillator is unavailable");
    }

    if (k > d && k < 85) {
      const strength = k < 30 ? 1 : 0.65;
      return RuleResultFactory.create(this.name, weight, "BULLISH", strength, "Stochastic momentum favors buyers", { k, d });
    }

    if (k < d && k > 15) {
      const strength = k > 70 ? 1 : 0.65;
      return RuleResultFactory.create(this.name, weight, "BEARISH", strength, "Stochastic momentum favors sellers", { k, d });
    }

    return RuleResultFactory.neutral(this.name, weight, "Stochastic oscillator is extended or flat", { k, d });
  }
}
