export interface SignalRuleWeights {
  trend: number;
  structure: number;
  structureEvent: number;
  movingAverage: number;
  macd: number;
  rsi: number;
  adx: number;
  stochastic: number;
  priceLocation: number;
  liquidity: number;
  orderBlock: number;
  fairValueGap: number;
  volume: number;
}

export interface SignalEngineConfig {
  minimumConfidence: number;
  minimumDirectionalEdge: number;
  minimumAnalysisScore: number;
  minimumDataQuality: number;
  minimumVolatilityPercent: number;
  maximumVolatilityPercent: number;
  requireIndicatorWarmup: boolean;
  minimumRiskReward: number;
  targetRiskReward: number;
  stopAtrMultiplier: number;
  stopBufferAtrMultiplier: number;
  maximumReasons: number;
  priceDigits: number;
  weights: SignalRuleWeights;
}
