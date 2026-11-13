import { Trend } from "@xauusd/types";
import type { ISignalRule } from "../contracts";
import type { SignalEngineConfig } from "../config";
import type { SignalContext, SignalRuleResult } from "../models";
import { RuleResultFactory } from "../utils";

export class TrendRule implements ISignalRule {
  readonly name = "TrendRule";

  evaluate(context: SignalContext, config: SignalEngineConfig): SignalRuleResult {
    const trend = context.analysis.trend;
    const weight = config.weights.trend;

    if (trend === Trend.Bullish) {
      return RuleResultFactory.create(this.name, weight, "BULLISH", 1, "Primary trend is bullish", { trend });
    }

    if (trend === Trend.Bearish) {
      return RuleResultFactory.create(this.name, weight, "BEARISH", 1, "Primary trend is bearish", { trend });
    }

    return RuleResultFactory.neutral(this.name, weight, "Primary trend is ranging", { trend });
  }
}
