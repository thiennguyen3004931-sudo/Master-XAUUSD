export class NumberUtils {
  static round(value: number, digits = 8): number {
    if (!Number.isFinite(value)) return value;
    const factor = 10 ** digits;
    return Math.round((value + Number.EPSILON) * factor) / factor;
  }

  static clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
  }

  static mean(values: readonly number[]): number {
    return values.length === 0
      ? 0
      : values.reduce((sum, value) => sum + value, 0) /
          values.length;
  }

  static median(values: readonly number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[middle - 1]! + sorted[middle]!) / 2
      : sorted[middle]!;
  }

  static standardDeviation(values: readonly number[]): number {
    if (values.length < 2) return 0;
    const mean = this.mean(values);
    const variance =
      values.reduce(
        (sum, value) => sum + (value - mean) ** 2,
        0,
      ) /
      (values.length - 1);
    return Math.sqrt(variance);
  }

  static percentile(
    values: readonly number[],
    percentile: number,
  ): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const bounded = this.clamp(percentile, 0, 1);
    const index = (sorted.length - 1) * bounded;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower]!;
    const weight = index - lower;
    return sorted[lower]! * (1 - weight) +
      sorted[upper]! * weight;
  }
}
