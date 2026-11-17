import type { ExecutionEngineConfig } from "../config";

export class ExecutionConfigValidator {
  validate(config: ExecutionEngineConfig): void {
    const positiveFields: Array<keyof ExecutionEngineConfig> = [
      "maxQuoteAgeMs",
      "maxSlippageTicks",
      "maxSpreadMultiplier",
      "idempotencyTtlMs",
      "maxExecutionsPerMinute",
      "minimumStopDistanceTicks",
      "minimumTargetDistanceTicks",
      "managementCommandTtlMs",
    ];

    for (const field of positiveFields) {
      const value = config[field];
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value <= 0
      ) {
        throw new RangeError(
          `${field} must be a finite positive number.`,
        );
      }
    }

    const nonNegativeFields: Array<keyof ExecutionEngineConfig> = [
      "planExpiryGraceMs",
      "breakEvenOffsetTicks",
      "minimumStopImprovementTicks",
    ];

    for (const field of nonNegativeFields) {
      const value = config[field];
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0
      ) {
        throw new RangeError(
          `${field} must be a finite non-negative number.`,
        );
      }
    }
  }
}
