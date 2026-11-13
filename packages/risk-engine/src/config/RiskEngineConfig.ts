export interface RiskEngineConfig {
  baseRiskPercent: number;
  minRiskPercent: number;
  maxRiskPercent: number;
  maxTotalOpenRiskPercent: number;
  maxDailyLossPercent: number;
  maxDrawdownPercent: number;
  maxMarginUsagePercent: number;
  minProjectedFreeMarginPercent: number;
  maxOpenPositions: number;
  maxOpenPositionsPerSymbol: number;
  maxConsecutiveLosses: number;
  cooldownAfterLossMinutes: number;
  minimumRiskReward: number;
  minimumConfidenceForFullRisk: number;
  confidenceFloorFactor: number;
  riskReductionPerConsecutiveLoss: number;
  maximumDrawdownRiskReduction: number;
  maximumSpreadMultiplier: number;
  sizeRoundingTolerancePercent: number;
}
