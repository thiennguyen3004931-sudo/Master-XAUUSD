import {
  MarketDataService,
  type Candle,
  type Timeframe,
} from "@xauusd/market-data";
import type { DetailedAnalysisResult } from "../models/DetailedAnalysisResult";
import type { IAnalysisEngine } from "../contracts/IAnalysisEngine";
import { AnalysisPipeline } from "../pipeline/AnalysisPipeline";

export class AnalysisService {
  constructor(
    private readonly marketDataService: MarketDataService,
    private readonly engine: IAnalysisEngine = new AnalysisPipeline(),
  ) {}

  async analyzeMarket(
    symbol: string,
    timeframe: Timeframe,
    limit = 200,
    refresh = false,
  ): Promise<DetailedAnalysisResult> {
    const candles = await this.marketDataService.getCandles(
      symbol,
      timeframe,
      limit,
      refresh,
    );

    return this.engine.analyze(symbol, timeframe, candles);
  }

  analyzeCandles(
    symbol: string,
    timeframe: Timeframe,
    candles: readonly Candle[],
  ): DetailedAnalysisResult {
    return this.engine.analyze(symbol, timeframe, candles);
  }
}
