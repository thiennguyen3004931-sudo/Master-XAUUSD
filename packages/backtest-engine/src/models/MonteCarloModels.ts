export interface MonteCarloConfig {
  iterations: number;
  seed: number;
  confidenceLevel: number;
}

export interface MonteCarloPathSummary {
  endingBalance: number;
  netProfit: number;
  maxDrawdownAmount: number;
  maxDrawdownPercent: number;
}

export interface MonteCarloResult {
  iterations: number;
  confidenceLevel: number;
  probabilityOfLossPercent: number;
  endingBalanceP05: number;
  endingBalanceMedian: number;
  endingBalanceP95: number;
  maxDrawdownP50: number;
  maxDrawdownP95: number;
  paths: MonteCarloPathSummary[];
}
