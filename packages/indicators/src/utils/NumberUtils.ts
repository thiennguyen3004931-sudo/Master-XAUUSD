export class NumberUtils {
  static assertPositiveInteger(value: number, name: string): void {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }

  static assertPositive(value: number, name: string): void {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive finite number`);
    }
  }

  static mean(values: readonly number[]): number {
    if (values.length === 0) {
      throw new RangeError("Cannot calculate the mean of an empty series");
    }

    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  static populationStandardDeviation(values: readonly number[]): number {
    const mean = NumberUtils.mean(values);
    const variance = values.reduce(
      (sum, value) => sum + (value - mean) ** 2,
      0,
    ) / values.length;

    return Math.sqrt(variance);
  }
}
