export interface RecentPerformanceSnapshot {
  sampleSize: number;
  winRatePercent: number;
  profitFactor: number;
  averageRMultiple: number;
  maxDrawdownPercent: number;
  consecutiveLosses: number;
  generatedAt: number;
}
