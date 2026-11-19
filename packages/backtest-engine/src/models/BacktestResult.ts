import type { BacktestConfig } from "../config";
import type { BacktestDiagnostics } from "./BacktestDiagnostics";
import type { BacktestStatus } from "./BacktestStatus";
import type { BacktestTrade } from "./BacktestTrade";
import type { DrawdownPoint } from "./DrawdownPoint";
import type { EquityPoint } from "./EquityPoint";
import type { MonthlyReturn } from "./MonthlyReturn";
import type { PerformanceMetrics } from "./PerformanceMetrics";

export interface BacktestResult {
  runId: string;
  status: BacktestStatus;
  symbol: string;
  timeframe: string;
  startedAt: number;
  completedAt: number;
  dataStartTime: number;
  dataEndTime: number;
  config: BacktestConfig;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  drawdownCurve: DrawdownPoint[];
  monthlyReturns: MonthlyReturn[];
  metrics: PerformanceMetrics;
  diagnostics: BacktestDiagnostics;
}
