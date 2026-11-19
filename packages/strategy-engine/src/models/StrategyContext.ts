import type {
  DetailedAnalysisResult,
  MultiTimeframeAnalysisResult,
} from "@xauusd/analysis-engine";
import type { IndicatorReport } from "@xauusd/indicators";
import type { RiskAssessment } from "@xauusd/risk-engine";
import type { SignalEngineResult } from "@xauusd/signal-engine";
import type { TradingSession } from "@xauusd/types";
import type { BotMode } from "./BotMode";

export interface StrategyContext {
  analysis: DetailedAnalysisResult;
  indicators: IndicatorReport;
  signalResult: SignalEngineResult;
  riskAssessment: RiskAssessment;
  multiTimeframe?: MultiTimeframeAnalysisResult;
  session?: TradingSession;
  botMode?: BotMode;
  evaluatedAt?: number;
}
