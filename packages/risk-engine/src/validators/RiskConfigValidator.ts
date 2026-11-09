import type { RiskEngineConfig } from "../config";

export class RiskConfigValidator {
  validate(config: RiskEngineConfig): void {
    const positiveFields: Array<keyof RiskEngineConfig> = [
      "baseRiskPercent",
      "minRiskPercent",
      "maxRiskPercent",
      "maxTotalOpenRiskPercent",
      "maxDailyLossPercent",
      "maxDrawdownPercent",
      "maxMarginUsagePercent",
      "minProjectedFreeMarginPercent",
      "maxOpenPositions",
      "maxOpenPositionsPerSymbol",
      "maxConsecutiveLosses",
      "minimumRiskReward",
      "minimumConfidenceForFullRisk",
      "maximumSpreadMultiplier",
    ];

    for (const field of positiveFields) {
      const value = config[field];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new RangeError(`${field} must be a finite positive number.`);
      }
    }

    if (config.minRiskPercent > config.maxRiskPercent) {
      throw new RangeError(
        "minRiskPercent cannot exceed maxRiskPercent.",
      );
    }

    if (config.baseRiskPercent > config.maxRiskPercent) {
      throw new RangeError(
        "baseRiskPercent cannot exceed maxRiskPercent.",
      );
    }

    if (
      config.confidenceFloorFactor <= 0 ||
      config.confidenceFloorFactor > 1
    ) {
      throw new RangeError(
        "confidenceFloorFactor must be greater than 0 and no more than 1.",
      );
    }

    if (
      config.riskReductionPerConsecutiveLoss < 0 ||
      config.riskReductionPerConsecutiveLoss >= 1
    ) {
      throw new RangeError(
        "riskReductionPerConsecutiveLoss must be in [0, 1).",
      );
    }

    if (
      config.maximumDrawdownRiskReduction < 0 ||
      config.maximumDrawdownRiskReduction >= 1
    ) {
      throw new RangeError(
        "maximumDrawdownRiskReduction must be in [0, 1).",
      );
    }

    if (
      config.cooldownAfterLossMinutes < 0 ||
      config.sizeRoundingTolerancePercent < 0
    ) {
      throw new RangeError(
        "Cooldown and rounding tolerance cannot be negative.",
      );
    }
  }
}
