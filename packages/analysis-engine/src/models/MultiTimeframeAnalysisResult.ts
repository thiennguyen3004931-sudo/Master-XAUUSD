import type { Timeframe } from "@xauusd/market-data";
import type { Trend } from "@xauusd/types";
import type { DetailedAnalysisResult } from "./DetailedAnalysisResult";

export interface TimeframeAnalysisEntry {
  timeframe: Timeframe;
  result: DetailedAnalysisResult;
}

export interface MultiTimeframeAnalysisResult {
  symbol: string;
  bias: Trend;
  confidence: number;
  alignedTimeframes: Timeframe[];
  analyses: TimeframeAnalysisEntry[];
  createdAt: number;
}
