import type { ISignalRule } from "../contracts";
import type { SignalEngineConfig } from "../config";
import type { SignalContext, SignalRuleResult } from "../models";
import { RuleResultFactory } from "../utils";

export class MacdRule implements ISignalRule {
  readonly name = "MacdRule";

  evaluate(context: SignalContext, config: SignalEngineConfig): SignalRuleResult {
    const weight = config.weights.macd;
    const { macd, signal, histogram } = context.indicators.latest.macd;

    if (macd === null || signal === null || histogram === null) {
      return RuleResultFactory.neutral(this.name, weight, "MACD is unavailable");
    }

    if (histogram > 0 && macd >= signal) {
      return RuleResultFactory.create(this.name, weight, "BULLISH", 1, "MACD momentum is bullish", { macd, signal, histogram });
    }

    if (histogram < 0 && macd <= signal) {
      return RuleResultFactory.create(this.name, weight, "BEARISH", 1, "MACD momentum is bearish", { macd, signal, histogram });
    }

    return RuleResultFactory.neutral(this.name, weight, "MACD has no directional confirmation", { macd, signal, histogram });
  }
}
