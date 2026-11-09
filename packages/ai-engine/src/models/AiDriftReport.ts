export interface FeatureDriftMetric {
  feature: string;
  baselineMean: number;
  currentMean: number;
  absoluteShift: number;
  normalizedShift: number;
  drifted: boolean;
}

export interface AiDriftReport {
  baselineSize: number;
  currentSize: number;
  driftedFeatureCount: number;
  drifted: boolean;
  metrics: FeatureDriftMetric[];
  generatedAt: number;
}
