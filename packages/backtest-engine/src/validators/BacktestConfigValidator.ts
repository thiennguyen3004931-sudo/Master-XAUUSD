import type { BacktestConfig } from "../config";

export class BacktestConfigValidator {
  validate(config: BacktestConfig): void {
    const positiveFields: Array<keyof BacktestConfig> = [
      "initialBalance",
      "contractSize",
      "tickSize",
      "volumeStep",
      "minVolume",
      "evaluateEveryBars",
      "maxConcurrentPositions",
      "trailingAtrPeriod",
      "annualTradingDays",
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

    const nonNegativeFields: Array<keyof BacktestConfig> = [
      "priceDigits",
      "fallbackSpread",
      "warmupBars",
      "breakEvenOffsetTicks",
      "riskFreeRateAnnual",
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

    if (
      !Number.isInteger(config.warmupBars) ||
      !Number.isInteger(config.evaluateEveryBars) ||
      !Number.isInteger(config.maxConcurrentPositions) ||
      !Number.isInteger(config.trailingAtrPeriod)
    ) {
      throw new RangeError(
        "Bar counts and position limits must be integers.",
      );
    }
  }
}
