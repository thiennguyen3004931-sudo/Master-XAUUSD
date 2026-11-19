import type { SignalEngineConfig } from "./SignalEngineConfig";

export const defaultSignalEngineConfig: SignalEngineConfig = {
  minimumConfidence: 62,
  minimumDirectionalEdge: 14,
  minimumAnalysisScore: 45,
  minimumDataQuality: 95,
  minimumVolatilityPercent: 0.02,
  maximumVolatilityPercent: 4,
  requireIndicatorWarmup: true,
  minimumRiskReward: 1.8,
  targetRiskReward: 2.5,
  stopAtrMultiplier: 1.25,
  stopBufferAtrMultiplier: 0.2,
  maximumReasons: 8,
  priceDigits: 2,
  weights: {
    trend: 13,
    structure: 13,
    structureEvent: 10,
    movingAverage: 10,
    macd: 9,
    rsi: 7,
    adx: 8,
    stochastic: 5,
    priceLocation: 8,
    liquidity: 5,
    orderBlock: 5,
    fairValueGap: 4,
    volume: 3
  }
};
