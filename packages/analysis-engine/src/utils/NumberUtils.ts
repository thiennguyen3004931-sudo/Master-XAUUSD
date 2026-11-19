export class NumberUtils {
  static clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  static percentageDifference(left: number, right: number): number {
    const denominator = Math.max(Math.abs(left), Math.abs(right));
    return denominator === 0 ? 0 : (Math.abs(left - right) / denominator) * 100;
  }

  static average(values: readonly number[]): number {
    if (values.length === 0) {
      return 0;
    }

    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
}
