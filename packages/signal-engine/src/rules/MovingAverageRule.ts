import type { ISignalRule } from "../contracts";
import type { SignalEngineConfig } from "../config";
import type { SignalContext, SignalRuleResult } from "../models";
import { RuleResultFactory } from "../utils";

export class MovingAverageRule implements ISignalRule {
  readonly name = "MovingAverageRule";

  evaluate(context: SignalContext, config: SignalEngineConfig): SignalRuleResult {
    const weight = config.weights.movingAverage;
    const entries = Object.entries(context.indicators.latest.ema)
      .map(([period, value]) => ({ period: Number(period), value }))
      .filter((entry): entry is { period: number; value: number } => Number.isFinite(entry.period) && entry.value !== null)
      .sort((left, right) => left.period - right.period);

    if (entries.length === 0) {
      return RuleResultFactory.neutral(this.name, weight, "EMA values are unavailable");
    }

    const close = context.indicators.latest.close;
    const fast = entries[0]!;
    const slow = entries.at(-1)!;

    if (close > fast.value && fast.value >= slow.value) {
      return RuleResultFactory.create(this.name, weight, "BULLISH", entries.length > 1 ? 1 : 0.65, "Price and EMA alignment are bullish", { close, fastEma: fast.value, slowEma: slow.value });
    }

    if (close < fast.value && fast.value <= slow.value) {
      return RuleResultFactory.create(this.name, weight, "BEARISH", entries.length > 1 ? 1 : 0.65, "Price and EMA alignment are bearish", { close, fastEma: fast.value, slowEma: slow.value });
    }

    const direction = close >= fast.value ? "BULLISH" : "BEARISH";
    return RuleResultFactory.create(this.name, weight, direction, 0.35, "Price has partial EMA alignment", { close, fastEma: fast.value, slowEma: slow.value });
  }
}
