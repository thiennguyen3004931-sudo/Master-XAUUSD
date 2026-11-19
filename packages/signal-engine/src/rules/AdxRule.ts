import type { ISignalRule } from "../contracts";
import type { SignalEngineConfig } from "../config";
import type { SignalContext, SignalRuleResult } from "../models";
import { RuleResultFactory } from "../utils";

export class AdxRule implements ISignalRule {
  readonly name = "AdxRule";

  evaluate(context: SignalContext, config: SignalEngineConfig): SignalRuleResult {
    const weight = config.weights.adx;
    const { adx, plusDI, minusDI } = context.indicators.latest.adx;

    if (adx === null || plusDI === null || minusDI === null) {
      return RuleResultFactory.neutral(this.name, weight, "ADX is unavailable");
    }

    if (adx < 18 || plusDI === minusDI) {
      return RuleResultFactory.neutral(this.name, weight, "ADX indicates weak or non-directional conditions", { adx, plusDI, minusDI });
    }

    const strength = Math.min(1, 0.45 + (adx - 18) / 35);
    const direction = plusDI > minusDI ? "BULLISH" : "BEARISH";
    return RuleResultFactory.create(this.name, weight, direction, strength, `ADX confirms ${direction.toLowerCase()} directional strength`, { adx, plusDI, minusDI });
  }
}
