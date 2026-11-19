import type { AnalysisConfig } from "./AnalysisConfig";

export const defaultAnalysisConfig: Readonly<AnalysisConfig> = Object.freeze({
  minCandles: 20,
  swing: {
    leftBars: 2,
    rightBars: 2,
    externalStrength: 4,
  },
  equalLevelTolerancePercent: 0.05,
  liquidityClusterTolerancePercent: 0.08,
  orderBlock: {
    atrPeriod: 14,
    displacementMultiplier: 1.5,
    lookback: 6,
    maxZones: 20,
  },
  fairValueGap: {
    minimumSize: 0,
    maxZones: 30,
  },
  supplyDemand: {
    atrPeriod: 14,
    displacementMultiplier: 1.2,
    lookback: 8,
    maxZones: 20,
  },
  volumeProfile: {
    lookback: 120,
    bins: 24,
    highVolumePercentile: 0.8,
    lowVolumePercentile: 0.2,
  },
});