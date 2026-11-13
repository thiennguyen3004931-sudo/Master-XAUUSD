import type { ISignalRule } from "../contracts";
import type { SignalEngineConfig } from "../config";
import type { SignalContext, SignalRuleResult } from "../models";
import { NumberUtils, RuleResultFactory } from "../utils";

export class OrderBlockRule implements ISignalRule {
  readonly name = "OrderBlockRule";

  evaluate(context: SignalContext, config: SignalEngineConfig): SignalRuleResult {
    const weight = config.weights.orderBlock;
    const close = context.indicators.latest.close;
    const atr = context.indicators.latest.atr ?? context.analysis.metrics.averageTrueRange;
    const active = context.analysis.orderBlocks.filter((zone) => !zone.mitigated);

    if (active.length === 0 || !NumberUtils.isFinitePositive(atr)) {
      return RuleResultFactory.neutral(this.name, weight, "No active order block is available");
    }

    const ranked = active
      .map((zone) => ({ zone, distance: close < zone.low ? zone.low - close : close > zone.high ? close - zone.high : 0 }))
      .sort((left, right) => left.distance - right.distance);
    const nearest = ranked[0]!;

    if (nearest.distance > atr * 2.5) {
      return RuleResultFactory.neutral(this.name, weight, "Nearest order block is too distant", { distanceAtr: nearest.distance / atr });
    }

    const direction = nearest.zone.bullish ? "BULLISH" : "BEARISH";
    const strength = nearest.distance === 0 ? 1 : Math.max(0.4, 1 - nearest.distance / (atr * 3));
    return RuleResultFactory.create(this.name, weight, direction, strength, `Price is near an active ${direction.toLowerCase()} order block`, { high: nearest.zone.high, low: nearest.zone.low, distanceAtr: nearest.distance / atr });
  }
}
