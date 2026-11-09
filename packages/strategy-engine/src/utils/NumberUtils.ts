export class NumberUtils {
  static clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
  }

  static round(value: number, digits = 2): number {
    const factor = 10 ** digits;
    return Math.round((value + Number.EPSILON) * factor) / factor;
  }

  static average(values: readonly number[]): number {
    return values.length === 0
      ? 0
      : values.reduce((sum, value) => sum + value, 0) / values.length;
  }
}
