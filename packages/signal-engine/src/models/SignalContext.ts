import type {
  DetailedAnalysisResult,
  MultiTimeframeAnalysisResult,
} from "@xauusd/analysis-engine";
import type { IndicatorReport } from "@xauusd/indicators";

export interface SignalContext {
  analysis: DetailedAnalysisResult;
  indicators: IndicatorReport;
  multiTimeframe?: MultiTimeframeAnalysisResult;
  evaluatedAt?: number;
}
