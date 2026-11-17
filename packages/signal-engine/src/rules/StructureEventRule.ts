import { Trend } from "@xauusd/types";
import type { ISignalRule } from "../contracts";
import type { SignalEngineConfig } from "../config";
import type { SignalContext, SignalRuleResult } from "../models";
import { RuleResultFactory } from "../utils";

export class StructureEventRule implements ISignalRule {
  readonly name = "StructureEventRule";

  evaluate(context: SignalContext, config: SignalEngineConfig): SignalRuleResult {
    const weight = config.weights.structureEvent;
    const event = [...context.analysis.structureEvents]
      .filter((item) => item.confirmed)
      .sort((left, right) => right.timestamp - left.timestamp)[0];

    if (!event) {
      return RuleResultFactory.neutral(this.name, weight, "No confirmed BOS or CHOCH event");
    }

    const strength = event.type === "CHOCH" ? 1 : 0.8;
    const direction = event.direction === Trend.Bullish ? "BULLISH" : "BEARISH";

    return RuleResultFactory.create(
      this.name,
      weight,
      direction,
      strength,
      `Latest confirmed structure event is ${event.type} ${direction.toLowerCase()}`,
      { type: event.type, level: event.level, timestamp: event.timestamp },
    );
  }
}
