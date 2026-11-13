import type { AiEngineConfig } from "../config";

export class AiConfigValidator {
  validate(config: AiEngineConfig): void {
    const positiveFields: Array<
      keyof AiEngineConfig
    > = [
      "providerTimeoutMs",
      "minimumProviderCount",
      "minimumAgreementRatio",
      "minimumOpinionConfidence",
      "maximumConfidenceAdjustment",
      "contextMaxAgeMs",
      "cacheTtlMs",
      "circuitBreakerFailureThreshold",
      "circuitBreakerResetMs",
      "maximumReasons",
      "maximumWarnings",
      "maximumTextLength"
    ];

    for (const field of positiveFields) {
      const value = config[field];
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value <= 0
      ) {
        throw new RangeError(
          `${field} must be a finite positive number.`
        );
      }
    }

    if (
      config.minimumAgreementRatio > 1
    ) {
      throw new RangeError(
        "minimumAgreementRatio cannot exceed 1."
      );
    }

    if (
      config.minimumOpinionConfidence > 100 ||
      config.maximumConfidenceAdjustment > 100
    ) {
      throw new RangeError(
        "Confidence percentages cannot exceed 100."
      );
    }

    if (
      !Number.isInteger(config.providerMaxRetries) ||
      config.providerMaxRetries < 0
    ) {
      throw new RangeError(
        "providerMaxRetries must be a non-negative integer."
      );
    }

    if (
      !config.promptVersion.trim() ||
      !config.schemaVersion.trim()
    ) {
      throw new Error(
        "Prompt and schema versions are required."
      );
    }
  }
}
