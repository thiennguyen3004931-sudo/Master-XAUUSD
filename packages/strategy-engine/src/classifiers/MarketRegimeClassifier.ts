import { MarketStructure, Trend } from "@xauusd/types";
import type { StrategyEngineConfig } from "../config";
import type {
  MarketRegimeAssessment,
  StrategyContext,
} from "../models";
import { NumberUtils, RangeBoundaryUtils } from "../utils";

const MAX_RANGE_WIDTH_ATR = 10;

export class MarketRegimeClassifier {
  classify(
    context: StrategyContext,
    config: StrategyEngineConfig,
  ): MarketRegimeAssessment {
    const adx = context.indicators.latest.adx.adx;
    const atr = context.indicators.latest.atr;
    const close = context.indicators.latest.close;
    const bandwidth = context.indicators.latest.bollingerBands.bandwidth;
    const confirmedBos = context.analysis.structureEvents.filter(
      (event) => event.confirmed && event.type === "BOS",
    );
    const confirmedChoch = context.analysis.structureEvents.filter(
      (event) => event.confirmed && event.type === "CHOCH",
    );
    const latestEvent = [...context.analysis.structureEvents]
      .filter((event) => event.confirmed)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    const supplyDemandRange = RangeBoundaryUtils.find(
      close,
      context.analysis.supplyDemandZones,
    );
    const rangeWidthAtr = supplyDemandRange && atr !== null && atr > 0
      ? supplyDemandRange.width / atr
      : null;
    const compactSupplyDemandRange = Boolean(
      supplyDemandRange &&
      (rangeWidthAtr === null || rangeWidthAtr <= MAX_RANGE_WIDTH_ATR),
    );
    const weakAdx = adx !== null && adx <= config.rangeAdxThreshold;
    const rangeStructure = context.analysis.structure === MarketStructure.Range;
    const confirmedSideway = compactSupplyDemandRange && (rangeStructure || weakAdx);

    const reasons: string[] = [];
    let regime: MarketRegimeAssessment["regime"] = "UNCERTAIN";
    let confidence = 45;

    if (latestEvent?.type === "CHOCH" && confirmedChoch.length > 0) {
      regime = "REVERSAL";
      confidence = 60 + Math.min(20, confirmedChoch.length * 5);
      reasons.push("A confirmed CHOCH indicates a possible structural reversal.");
    } else if (
      latestEvent?.type === "BOS" &&
      adx !== null &&
      adx >= config.breakoutAdxThreshold
    ) {
      regime = "BREAKOUT";
      confidence = 65 + Math.min(20, (adx - config.breakoutAdxThreshold) * 1.5);
      reasons.push("Confirmed BOS is supported by directional ADX strength.");
    } else if (confirmedSideway && supplyDemandRange) {
      regime = "RANGING";
      confidence = 62;
      confidence += weakAdx && adx !== null
        ? Math.min(12, config.rangeAdxThreshold - adx)
        : 0;
      confidence += Math.min(10, Math.max(0, supplyDemandRange.quality - 6) * 2);
      confidence += rangeStructure ? 6 : 0;
      reasons.push(
        `Supply/Demand confirms sideway: demand ${NumberUtils.round(supplyDemandRange.demand.low, 2)}-${NumberUtils.round(supplyDemandRange.demand.high, 2)}, supply ${NumberUtils.round(supplyDemandRange.supply.low, 2)}-${NumberUtils.round(supplyDemandRange.supply.high, 2)}.`,
      );
      reasons.push(
        `Price is trapped at ${(supplyDemandRange.position * 100).toFixed(0)}% of the approved range; trend strategy should stay paused.`,
      );
      if (rangeWidthAtr !== null) {
        reasons.push(`Supply/Demand range width is ${NumberUtils.round(rangeWidthAtr, 2)} ATR.`);
      }
    } else if (
      context.analysis.trend !== Trend.Ranging &&
      context.analysis.structure !== MarketStructure.Range &&
      adx !== null &&
      adx >= config.trendAdxThreshold
    ) {
      regime = "TRENDING";
      confidence = 60 + Math.min(25, adx - config.trendAdxThreshold);
      reasons.push("Trend, market structure and ADX support continuation.");
    } else if (rangeStructure || weakAdx) {
      regime = "UNCERTAIN";
      confidence = 50;
      reasons.push(
        "Sideway is suspected by structure/ADX but no qualified Supply/Demand corridor confirms it; both trend and range execution should wait.",
      );
    } else {
      reasons.push("Regime inputs are mixed and do not support a strong classification.");
    }

    if (supplyDemandRange && !compactSupplyDemandRange && rangeWidthAtr !== null) {
      reasons.push(
        `Supply/Demand corridor is too wide (${NumberUtils.round(rangeWidthAtr, 2)} ATR) to treat as a tradeable sideway range.`,
      );
    }

    if (bandwidth !== null && bandwidth > 0) {
      reasons.push(`Bollinger bandwidth is ${NumberUtils.round(bandwidth, 4)}.`);
    }

    if (context.multiTimeframe) {
      confidence += Math.min(10, context.multiTimeframe.confidence / 10);
      reasons.push("Multi-timeframe analysis was available for regime confirmation.");
    }

    confidence = NumberUtils.clamp(confidence, 0, 100);

    return {
      regime,
      confidence: NumberUtils.round(confidence),
      reasons,
      metrics: {
        adx,
        bollingerBandwidth: bandwidth,
        volatilityPercent: context.analysis.metrics.volatilityPercent,
        confirmedBosCount: confirmedBos.length,
        confirmedChochCount: confirmedChoch.length,
      },
    };
  }
}
