import type { Candle, Timeframe } from "@xauusd/market-data";
import type { DetailedAnalysisResult } from "../models/DetailedAnalysisResult";

export interface IAnalysisEngine {
  analyze(
    symbol: string,
    timeframe: Timeframe,
    candles: readonly Candle[],
  ): DetailedAnalysisResult;
}
