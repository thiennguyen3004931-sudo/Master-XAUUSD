import type { RiskEngineConfig } from "./RiskEngineConfig";

export const defaultRiskEngineConfig: RiskEngineConfig = {
  baseRiskPercent: 1,
  minRiskPercent: 0.25,
  maxRiskPercent: 1.5,
  maxTotalOpenRiskPercent: 4,
  maxDailyLossPercent: 3,
  maxDrawdownPercent: 10,
  maxMarginUsagePercent: 35,
  minProjectedFreeMarginPercent: 30,
  maxOpenPositions: 3,
  maxOpenPositionsPerSymbol: 1,
  maxConsecutiveLosses: 3,
  cooldownAfterLossMinutes: 60,
  minimumRiskReward: 1.8,
  minimumConfidenceForFullRisk: 80,
  confidenceFloorFactor: 0.5,
  riskReductionPerConsecutiveLoss: 0.15,
  maximumDrawdownRiskReduction: 0.75,
  maximumSpreadMultiplier: 1,
  sizeRoundingTolerancePercent: 5,
};
