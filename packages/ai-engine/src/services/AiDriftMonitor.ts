import type {
  AiDriftReport,
  AiFeatureVector,
  FeatureDriftMetric
} from "../models";
import {
  NumberUtils
} from "../utils";

export interface AiDriftMonitorConfig {
  normalizedShiftThreshold: number;
}

export class AiDriftMonitor {
  constructor(
    private readonly config:
      AiDriftMonitorConfig = {
        normalizedShiftThreshold: 1
      }
  ) {}

  compare(
    baseline:
      readonly AiFeatureVector[],
    current:
      readonly AiFeatureVector[],
    generatedAt = Date.now()
  ): AiDriftReport {
    const numericFeatures =
      this.numericFeatureNames(
        baseline[0] ?? current[0]
      );
    const metrics: FeatureDriftMetric[] =
      numericFeatures.map((feature) => {
        const baselineValues =
          this.values(baseline, feature);
        const currentValues =
          this.values(current, feature);
        const baselineMean =
          NumberUtils.mean(baselineValues);
        const currentMean =
          NumberUtils.mean(currentValues);
        const absoluteShift =
          Math.abs(currentMean - baselineMean);
        const baselineStd =
          NumberUtils.standardDeviation(
            baselineValues
          );
        const denominator =
          baselineStd > 1e-8
            ? baselineStd
            : Math.max(
                Math.abs(baselineMean),
                1
              );
        const normalizedShift =
          absoluteShift / denominator;

        return {
          feature,
          baselineMean:
            NumberUtils.round(baselineMean),
          currentMean:
            NumberUtils.round(currentMean),
          absoluteShift:
            NumberUtils.round(absoluteShift),
          normalizedShift:
            NumberUtils.round(normalizedShift),
          drifted:
            normalizedShift >=
            this.config.normalizedShiftThreshold
        };
      });

    const driftedFeatureCount =
      metrics.filter((metric) => metric.drifted)
        .length;

    return {
      baselineSize: baseline.length,
      currentSize: current.length,
      driftedFeatureCount,
      drifted: driftedFeatureCount > 0,
      metrics,
      generatedAt
    };
  }

  private numericFeatureNames(
    example: AiFeatureVector | undefined
  ): string[] {
    if (!example) return [];
    return Object.entries(example)
      .filter(
        ([, value]) =>
          typeof value === "number"
      )
      .map(([key]) => key);
  }

  private values(
    vectors: readonly AiFeatureVector[],
    feature: string
  ): number[] {
    return vectors.flatMap((vector) => {
      const value =
        (vector as unknown as
          Record<string, unknown>)[feature];
      return typeof value === "number" &&
        Number.isFinite(value)
        ? [value]
        : [];
    });
  }
}
