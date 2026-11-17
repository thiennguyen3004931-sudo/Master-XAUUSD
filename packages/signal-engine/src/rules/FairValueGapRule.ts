import type { ISignalRule } from "../contracts";
import type { SignalEngineConfig } from "../config";
import type { SignalContext, SignalRuleResult } from "../models";
import { NumberUtils, RuleResultFactory } from "../utils";

export class FairValueGapRule implements ISignalRule {
  readonly name = "FairValueGapRule";

  evaluate(context: SignalContext, config: SignalEngineConfig): SignalRuleResult {
    const weight = config.weights.fairValueGap;
    const close = context.indicators.latest.close;
    const atr = context.indicators.latest.atr ?? context.analysis.metrics.averageTrueRange;
    const gaps = context.analysis.fairValueGaps.filter((gap) => !gap.filled && typeof gap.bullish === "boolean");

    if (gaps.length === 0 || !NumberUtils.isFinitePositive(atr)) {
      return RuleResultFactory.neutral(this.name, weight, "No active directional fair value gap");
    }

    const ranked = gaps
      .map((gap) => ({ gap, distance: close < gap.low ? gap.low - close : close > gap.high ? close - gap.high : 0 }))
      .sort((left, right) => left.distance - right.distance);
    const nearest = ranked[0]!;

    if (nearest.distance > atr * 2) {
      return RuleResultFactory.neutral(this.name, weight, "Nearest fair value gap is too distant", { distanceAtr: nearest.distance / atr });
    }

    const direction = nearest.gap.bullish ? "BULLISH" : "BEARISH";
    const strength = nearest.distance === 0 ? 1 : Math.max(0.35, 1 - nearest.distance / (atr * 2.5));
    return RuleResultFactory.create(this.name, weight, direction, strength, `Active ${direction.toLowerCase()} fair value gap supports the setup`, { high: nearest.gap.high, low: nearest.gap.low, distanceAtr: nearest.distance / atr });
  }
}
