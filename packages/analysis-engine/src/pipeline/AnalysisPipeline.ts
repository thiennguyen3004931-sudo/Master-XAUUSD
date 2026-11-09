import type { Candle, Timeframe } from "@xauusd/market-data";
import { Trend } from "@xauusd/types";
import type { IAnalysisEngine } from "../contracts/IAnalysisEngine";
import {
  defaultAnalysisConfig,
  type AnalysisConfig,
} from "../config";
import {
  EqualHighLowDetector,
  FairValueGapDetector,
  LiquidityDetector,
  MarketStructureDetector,
  OrderBlockDetector,
  PremiumDiscountDetector,
  StructureEventDetector,
  SupplyDemandDetector,
  SwingDetector,
  TrendDetector,
  VolumeProfileAnalyzer,
} from "../detectors";
import type { DetailedAnalysisResult } from "../models/DetailedAnalysisResult";
import { AnalysisMetricsService } from "../services/AnalysisMetricsService";
import { AnalysisScoreService } from "../services/AnalysisScoreService";
import { AnalysisInputValidator } from "../validators/AnalysisInputValidator";

export class AnalysisPipeline implements IAnalysisEngine {
  private readonly config: AnalysisConfig;

  constructor(
    config: Partial<AnalysisConfig> = {},
    private readonly validator = new AnalysisInputValidator(),
    private readonly swingDetector = new SwingDetector(),
    private readonly trendDetector = new TrendDetector(),
    private readonly structureDetector = new MarketStructureDetector(),
    private readonly equalHighLowDetector = new EqualHighLowDetector(),
    private readonly liquidityDetector = new LiquidityDetector(),
    private readonly orderBlockDetector = new OrderBlockDetector(),
    private readonly fairValueGapDetector = new FairValueGapDetector(),
    private readonly premiumDiscountDetector = new PremiumDiscountDetector(),
    private readonly structureEventDetector = new StructureEventDetector(),
    private readonly metricsService = new AnalysisMetricsService(),
    private readonly scoreService = new AnalysisScoreService(),
    private readonly supplyDemandDetector = new SupplyDemandDetector(),
    private readonly volumeProfileAnalyzer = new VolumeProfileAnalyzer(),
  ) {
    this.config = this.mergeConfig(config);
  }

  analyze(
    symbol: string,
    timeframe: Timeframe,
    candles: readonly Candle[],
  ): DetailedAnalysisResult {
    this.validator.validate(symbol, timeframe, candles, this.config);

    const snapshot = candles.map((candle) => ({ ...candle }));
    const swings = this.swingDetector.detect(snapshot, this.config.swing);
    const trend = this.trendDetector.detect(swings);
    const structure = this.structureDetector.detect(swings);
    const { equalHighs, equalLows } = this.equalHighLowDetector.detect(
      swings,
      this.config.equalLevelTolerancePercent,
    );
    const liquidityZones = this.liquidityDetector.detect(
      swings,
      snapshot,
      this.config.liquidityClusterTolerancePercent,
    );
    const orderBlocks = this.orderBlockDetector.detect(
      snapshot,
      this.config.orderBlock,
    );
    const fairValueGaps = this.fairValueGapDetector.detect(
      snapshot,
      this.config.fairValueGap,
    );
    const supplyDemandZones = this.supplyDemandDetector.detect(
      snapshot,
      this.config.supplyDemand,
    );
    const volumeProfile = this.volumeProfileAnalyzer.analyze(
      snapshot,
      this.config.volumeProfile,
    );
    const zones = this.premiumDiscountDetector.detect(snapshot);
    const structureEvents = this.structureEventDetector.detect(
      snapshot,
      swings,
    );
    const metrics = this.metricsService.calculate(snapshot);

    const externalSwings = swings.filter(
      (swing) => swing.strength >= this.config.swing.externalStrength,
    );
    const effectiveExternalSwings = externalSwings.length > 0
      ? externalSwings
      : swings.slice(-4);
    const externalIndexes = new Set(
      effectiveExternalSwings.map((swing) => swing.index),
    );
    const internalSwings = swings.filter(
      (swing) => !externalIndexes.has(swing.index),
    );

    const baseResult: Omit<DetailedAnalysisResult, "score"> = {
      symbol: symbol.trim().toUpperCase(),
      timeframe,
      trend: swings.length === 0 ? Trend.Ranging : trend,
      structure,
      lastCandle: { ...snapshot.at(-1)! },
      swings,
      internalSwings,
      externalSwings: effectiveExternalSwings,
      liquidityZones,
      orderBlocks,
      fairValueGaps,
      equalHighs,
      equalLows,
      premiumZone: zones.premiumZone,
      discountZone: zones.discountZone,
      equilibrium: zones.equilibrium,
      createdAt: Date.now(),
      metrics,
      structureEvents,
      supplyDemandZones,
      volumeProfile,
    };

    return {
      ...baseResult,
      score: this.scoreService.calculate(baseResult),
    };
  }

  private mergeConfig(config: Partial<AnalysisConfig>): AnalysisConfig {
    return {
      ...defaultAnalysisConfig,
      ...config,
      swing: {
        ...defaultAnalysisConfig.swing,
        ...config.swing,
      },
      orderBlock: {
        ...defaultAnalysisConfig.orderBlock,
        ...config.orderBlock,
      },
      fairValueGap: {
        ...defaultAnalysisConfig.fairValueGap,
        ...config.fairValueGap,
      },
      supplyDemand: {
        ...defaultAnalysisConfig.supplyDemand,
        ...config.supplyDemand,
      },
      volumeProfile: {
        ...defaultAnalysisConfig.volumeProfile,
        ...config.volumeProfile,
      },
    };
  }
}