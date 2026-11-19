export interface SwingDetectionConfig {
  leftBars: number;
  rightBars: number;
  externalStrength: number;
}

export interface OrderBlockDetectionConfig {
  atrPeriod: number;
  displacementMultiplier: number;
  lookback: number;
  maxZones: number;
}

export interface FairValueGapDetectionConfig {
  minimumSize: number;
  maxZones: number;
}

export interface SupplyDemandDetectionConfig {
  atrPeriod: number;
  displacementMultiplier: number;
  lookback: number;
  maxZones: number;
}

export interface VolumeProfileConfig {
  lookback: number;
  bins: number;
  highVolumePercentile: number;
  lowVolumePercentile: number;
}

export interface AnalysisConfig {
  minCandles: number;
  swing: SwingDetectionConfig;
  equalLevelTolerancePercent: number;
  liquidityClusterTolerancePercent: number;
  orderBlock: OrderBlockDetectionConfig;
  fairValueGap: FairValueGapDetectionConfig;
  supplyDemand: SupplyDemandDetectionConfig;
  volumeProfile: VolumeProfileConfig;
}