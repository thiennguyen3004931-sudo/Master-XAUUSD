import type { SignalEngineConfig } from "../config";

export class SignalConfigValidator {
  validate(config: SignalEngineConfig): void {
    const percentages: Array<[string, number]> = [
      ["minimumConfidence", config.minimumConfidence],
      ["minimumDirectionalEdge", config.minimumDirectionalEdge],
      ["minimumAnalysisScore", config.minimumAnalysisScore],
      ["minimumDataQuality", config.minimumDataQuality],
    ];

    for (const [name, value] of percentages) {
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new RangeError(`${name} must be between 0 and 100`);
      }
    }

    if (config.minimumVolatilityPercent < 0 || config.maximumVolatilityPercent <= config.minimumVolatilityPercent) {
      throw new RangeError("volatility limits are invalid");
    }
    if (config.minimumRiskReward <= 0 || config.targetRiskReward < config.minimumRiskReward) {
      throw new RangeError("risk-reward configuration is invalid");
    }
    if (config.stopAtrMultiplier <= 0 || config.stopBufferAtrMultiplier < 0) {
      throw new RangeError("ATR stop configuration is invalid");
    }
    if (!Number.isInteger(config.maximumReasons) || config.maximumReasons < 1) {
      throw new RangeError("maximumReasons must be a positive integer");
    }
    if (!Number.isInteger(config.priceDigits) || config.priceDigits < 0 || config.priceDigits > 8) {
      throw new RangeError("priceDigits must be an integer between 0 and 8");
    }

    for (const [name, value] of Object.entries(config.weights)) {
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`weight ${name} must be a non-negative finite number`);
      }
    }

    const totalWeight = Object.values(config.weights).reduce((sum, value) => sum + value, 0);
    if (totalWeight <= 0) {
      throw new RangeError("at least one signal rule weight must be greater than zero");
    }
  }
}
