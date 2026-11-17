export class NumberUtils {
  static clamp(
    value: number,
    minimum: number,
    maximum: number
  ): number {
    return Math.min(maximum, Math.max(minimum, value));
  }

  static round(value: number, digits = 8): number {
    if (!Number.isFinite(value)) return value;
    const factor = 10 ** digits;
    return Math.round((value + Number.EPSILON) * factor) / factor;
  }

  static mean(values: readonly number[]): number {
    return values.length === 0
      ? 0
      : values.reduce((sum, value) => sum + value, 0) /
          values.length;
  }

  static standardDeviation(
    values: readonly number[]
  ): number {
    if (values.length < 2) return 0;
    const mean = this.mean(values);
    const variance =
      values.reduce(
        (sum, value) => sum + (value - mean) ** 2,
        0
      ) /
      (values.length - 1);
    return Math.sqrt(variance);
  }
}
