import type { ISignalRule } from "../contracts";
import type { SignalEngineConfig } from "../config";
import type { SignalContext, SignalRuleResult } from "../models";
import { RuleResultFactory } from "../utils";

export class VolumeRule implements ISignalRule {
  readonly name = "VolumeRule";

  evaluate(context: SignalContext, config: SignalEngineConfig): SignalRuleResult {
    const weight = config.weights.volume;
    const candle = context.analysis.lastCandle;
    const volumeAverage = context.indicators.latest.volumeSma;

    if (!candle || volumeAverage === null || volumeAverage <= 0) {
      return RuleResultFactory.neutral(this.name, weight, "Volume confirmation is unavailable");
    }

    const ratio = candle.volume / volumeAverage;
    if (ratio < 1.05 || candle.close === candle.open) {
      return RuleResultFactory.neutral(this.name, weight, "Volume does not confirm directional expansion", { ratio });
    }

    const direction = candle.close > candle.open ? "BULLISH" : "BEARISH";
    const strength = Math.min(1, 0.45 + (ratio - 1.05) / 0.8);
    return RuleResultFactory.create(this.name, weight, direction, strength, `Above-average volume confirms ${direction.toLowerCase()} expansion`, { ratio, volume: candle.volume, volumeAverage });
  }
}
