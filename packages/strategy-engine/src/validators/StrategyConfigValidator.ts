import type { StrategyEngineConfig } from "../config";

export class StrategyConfigValidator {
  validate(config: StrategyEngineConfig): void {
    const percentages = [
      config.minimumCandidateScore,
      config.minimumCandidateEdge,
      config.minimumRegimeConfidence,
      config.trendAdxThreshold,
      config.rangeAdxThreshold,
      config.breakoutAdxThreshold,
      config.reversalRsiOversold,
      config.reversalRsiOverbought,
    ];
    if (percentages.some((value) => !Number.isFinite(value) || value < 0 || value > 100)) {
      throw new RangeError("Score, confidence, ADX and RSI thresholds must be finite values in [0, 100].");
    }
    if (config.maximumContextAgeMs <= 0 || !Number.isFinite(config.maximumContextAgeMs)) {
      throw new RangeError("maximumContextAgeMs must be positive.");
    }
    if (config.minimumCandidateEdge > config.minimumCandidateScore) {
      throw new RangeError("minimumCandidateEdge cannot exceed minimumCandidateScore.");
    }
    if (config.rangeAdxThreshold >= config.trendAdxThreshold) {
      throw new RangeError("rangeAdxThreshold must be lower than trendAdxThreshold.");
    }
    if (config.reversalRsiOversold >= config.reversalRsiOverbought) {
      throw new RangeError("Oversold RSI threshold must be below the overbought threshold.");
    }
    for (const [id, weight] of Object.entries(config.strategyWeights)) {
      if (!Number.isFinite(weight) || weight <= 0 || weight > 2) {
        throw new RangeError(`strategyWeights.${id} must be in (0, 2].`);
      }
    }
    for (const [id, minutes] of Object.entries(config.maximumHoldingMinutes)) {
      if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new RangeError(`maximumHoldingMinutes.${id} must be positive.`);
      }
    }
  }
}
