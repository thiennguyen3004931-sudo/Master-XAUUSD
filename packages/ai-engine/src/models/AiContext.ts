import type {
  DetailedAnalysisResult,
  MultiTimeframeAnalysisResult
} from "@xauusd/analysis-engine";
import type { PerformanceMetrics } from "@xauusd/backtest-engine";
import type { IndicatorReport } from "@xauusd/indicators";
import type { RiskAssessment } from "@xauusd/risk-engine";
import type { SignalEngineResult } from "@xauusd/signal-engine";
import type { StrategyEvaluation } from "@xauusd/strategy-engine";
import type { RecentPerformanceSnapshot } from "./RecentPerformanceSnapshot";

export interface AiContext {
  analysis: DetailedAnalysisResult;
  indicators: IndicatorReport;
  signalResult: SignalEngineResult;
  riskAssessment: RiskAssessment;
  strategyEvaluation: StrategyEvaluation;
  multiTimeframe?: MultiTimeframeAnalysisResult;
  backtestMetrics?: PerformanceMetrics;
  recentPerformance?: RecentPerformanceSnapshot;
  evaluatedAt?: number;
  metadata?: Readonly<Record<string, string | number | boolean>>;
}
