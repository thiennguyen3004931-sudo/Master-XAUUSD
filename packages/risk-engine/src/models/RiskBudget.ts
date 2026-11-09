export interface RiskBudget {
  baseRiskPercent: number;
  confidenceFactor: number;
  strengthFactor: number;
  drawdownFactor: number;
  lossStreakFactor: number;
  availablePortfolioRiskAmount: number;
  requestedRiskPercent: number;
  requestedRiskAmount: number;
  approvedRiskPercent: number;
  approvedRiskAmount: number;
}
