import { MarketStructure, Trend } from "@xauusd/types";
import type { DetailedAnalysisResult } from "../models/DetailedAnalysisResult";
import { NumberUtils } from "../utils/NumberUtils";

export class AnalysisScoreService {
  calculate(result: Omit<DetailedAnalysisResult, "score">): number {
    let score = 0;

    const aligned =
      (result.trend === Trend.Bullish &&
        result.structure === MarketStructure.Bullish) ||
      (result.trend === Trend.Bearish &&
        result.structure === MarketStructure.Bearish);

    score += aligned ? 30 : result.trend === Trend.Ranging ? 8 : 15;
    score += Math.min(15, result.externalSwings.length * 3);
    score += Math.min(10, result.liquidityZones.length * 2);
    score += Math.min(15, result.orderBlocks.filter((zone) => !zone.mitigated).length * 5);
    score += Math.min(15, result.fairValueGaps.filter((gap) => !gap.filled).length * 3);
    score += Math.min(10, result.structureEvents.length * 2);
    score += result.metrics.dataQuality >= 99 ? 5 : 0;

    return Math.round(NumberUtils.clamp(score, 0, 100));
  }
}
