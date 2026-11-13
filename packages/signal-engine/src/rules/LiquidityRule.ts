import type { ISignalRule } from "../contracts";
import type { SignalEngineConfig } from "../config";
import type { SignalContext, SignalRuleResult } from "../models";
import { NumberUtils, RuleResultFactory } from "../utils";

export class LiquidityRule implements ISignalRule {
  readonly name = "LiquidityRule";

  evaluate(context: SignalContext, config: SignalEngineConfig): SignalRuleResult {
    const weight = config.weights.liquidity;
    const close = context.indicators.latest.close;
    const atr = context.indicators.latest.atr ?? context.analysis.metrics.averageTrueRange;
    const zones = context.analysis.liquidityZones.filter((zone) => !zone.touched);

    if (zones.length === 0 || !NumberUtils.isFinitePositive(atr)) {
      return RuleResultFactory.neutral(this.name, weight, "No usable untapped liquidity zone");
    }

    const above = zones.filter((zone) => zone.price > close).sort((a, b) => a.price - b.price)[0];
    const below = zones.filter((zone) => zone.price < close).sort((a, b) => b.price - a.price)[0];
    const aboveDistance = above ? (above.price - close) / atr : Number.POSITIVE_INFINITY;
    const belowDistance = below ? (close - below.price) / atr : Number.POSITIVE_INFINITY;

    if (aboveDistance < belowDistance && aboveDistance <= 4) {
      return RuleResultFactory.create(this.name, weight, "BULLISH", Math.max(0.35, 1 - aboveDistance / 5), "Nearest liquidity draw is above price", { aboveDistanceAtr: aboveDistance, target: above!.price });
    }

    if (belowDistance < aboveDistance && belowDistance <= 4) {
      return RuleResultFactory.create(this.name, weight, "BEARISH", Math.max(0.35, 1 - belowDistance / 5), "Nearest liquidity draw is below price", { belowDistanceAtr: belowDistance, target: below!.price });
    }

    return RuleResultFactory.neutral(this.name, weight, "Liquidity is balanced or too distant", { aboveDistanceAtr: Number.isFinite(aboveDistance) ? aboveDistance : null, belowDistanceAtr: Number.isFinite(belowDistance) ? belowDistance : null });
  }
}
