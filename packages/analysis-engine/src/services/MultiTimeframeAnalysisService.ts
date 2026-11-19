import { type Timeframe } from "@xauusd/market-data";
import { Trend } from "@xauusd/types";
import type { MultiTimeframeAnalysisResult } from "../models/MultiTimeframeAnalysisResult";
import { NumberUtils } from "../utils/NumberUtils";
import { AnalysisService } from "./AnalysisService";

export class MultiTimeframeAnalysisService {
  constructor(private readonly analysisService: AnalysisService) {}

  async analyze(
    symbol: string,
    timeframes: readonly Timeframe[],
    limit = 200,
    refresh = false,
  ): Promise<MultiTimeframeAnalysisResult> {
    if (timeframes.length === 0) {
      throw new RangeError("at least one timeframe is required");
    }

    const analyses = await Promise.all(
      timeframes.map(async (timeframe) => ({
        timeframe,
        result: await this.analysisService.analyzeMarket(
          symbol,
          timeframe,
          limit,
          refresh,
        ),
      })),
    );

    const bullish = analyses.filter(
      (entry) => entry.result.trend === Trend.Bullish,
    );
    const bearish = analyses.filter(
      (entry) => entry.result.trend === Trend.Bearish,
    );
    const bias = bullish.length > bearish.length
      ? Trend.Bullish
      : bearish.length > bullish.length
        ? Trend.Bearish
        : Trend.Ranging;
    const alignedTimeframes = analyses
      .filter((entry) => entry.result.trend === bias)
      .map((entry) => entry.timeframe);
    const averageScore =
      analyses.reduce((sum, entry) => sum + entry.result.score, 0) /
      analyses.length;
    const alignmentRatio = alignedTimeframes.length / analyses.length;

    return {
      symbol: symbol.trim().toUpperCase(),
      bias,
      confidence: Math.round(
        NumberUtils.clamp(averageScore * alignmentRatio, 0, 100),
      ),
      alignedTimeframes,
      analyses,
      createdAt: Date.now(),
    };
  }
}
