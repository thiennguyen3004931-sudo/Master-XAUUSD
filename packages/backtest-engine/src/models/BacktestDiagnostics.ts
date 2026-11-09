export interface BacktestDiagnostics {
  warnings: string[];
  candlesProcessed: number;
  strategyEvaluations: number;
  executablePlans: number;
  entriesFilled: number;
  pendingOrdersExpired: number;
  plansSkippedByCapacity: number;
  invalidStrategyPlans: number;
}
