export class NumberUtils {
  static clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
  }

  static percentOf(value: number, total: number): number {
    return total === 0 ? 0 : (value / total) * 100;
  }

  static round(value: number, digits = 8): number {
    const factor = 10 ** digits;
    return Math.round((value + Number.EPSILON) * factor) / factor;
  }

  static isFinitePositive(value: number): boolean {
    return Number.isFinite(value) && value > 0;
  }
}
