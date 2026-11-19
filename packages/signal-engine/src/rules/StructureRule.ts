import { MarketStructure } from "@xauusd/types";
import type { ISignalRule } from "../contracts";
import type { SignalEngineConfig } from "../config";
import type { SignalContext, SignalRuleResult } from "../models";
import { RuleResultFactory } from "../utils";

export class StructureRule implements ISignalRule {
  readonly name = "StructureRule";

  evaluate(context: SignalContext, config: SignalEngineConfig): SignalRuleResult {
    const structure = context.analysis.structure;
    const weight = config.weights.structure;

    if (structure === MarketStructure.Bullish) {
      return RuleResultFactory.create(this.name, weight, "BULLISH", 1, "Market structure is bullish", { structure });
    }

    if (structure === MarketStructure.Bearish) {
      return RuleResultFactory.create(this.name, weight, "BEARISH", 1, "Market structure is bearish", { structure });
    }

    return RuleResultFactory.neutral(this.name, weight, "Market structure is ranging", { structure });
  }
}
