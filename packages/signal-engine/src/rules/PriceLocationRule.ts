import type { ISignalRule } from "../contracts";
import type { SignalEngineConfig } from "../config";
import type { SignalContext, SignalRuleResult } from "../models";
import { RuleResultFactory } from "../utils";

export class PriceLocationRule implements ISignalRule {
  readonly name = "PriceLocationRule";

  evaluate(context: SignalContext, config: SignalEngineConfig): SignalRuleResult {
    const weight = config.weights.priceLocation;
    const close = context.indicators.latest.close;
    const { discountZone, premiumZone, equilibrium } = context.analysis;

    if (close <= discountZone) {
      return RuleResultFactory.create(this.name, weight, "BULLISH", 1, "Price is in the discount zone", { close, discountZone, equilibrium });
    }

    if (close >= premiumZone) {
      return RuleResultFactory.create(this.name, weight, "BEARISH", 1, "Price is in the premium zone", { close, premiumZone, equilibrium });
    }

    if (close < equilibrium) {
      return RuleResultFactory.create(this.name, weight, "BULLISH", 0.45, "Price is below equilibrium", { close, equilibrium });
    }

    if (close > equilibrium) {
      return RuleResultFactory.create(this.name, weight, "BEARISH", 0.45, "Price is above equilibrium", { close, equilibrium });
    }

    return RuleResultFactory.neutral(this.name, weight, "Price is at equilibrium", { close, equilibrium });
  }
}
