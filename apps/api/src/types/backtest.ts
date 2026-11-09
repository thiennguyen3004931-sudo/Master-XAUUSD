export interface BacktestRunRequestDto {
  symbol: string;
  timeframe: string;
  from: string;
  to: string;
  initialBalance: number;
  riskPercent: number;
  spread: number;
  slippageTicks: number;
  intrabarPriority: "STOP_FIRST" | "OHLC_PATH";
}

export interface BacktestResultDto {
  runId: string;
  source: "PACK10";
  generatedAt: number;
  metrics: {
    netReturnPercent: number;
    netProfit: number;
    totalTrades: number;
    winRatePercent: number;
    profitFactor: number;
    expectancy: number;
    maxDrawdownPercent: number;
    sharpeRatio: number;
    averageRMultiple: number;
  };
  equityCurve: Array<{ timestamp: number; balance: number; equity: number }>;
  drawdownCurve: Array<{ timestamp: number; drawdownPercent: number }>;
  warnings: string[];
}
