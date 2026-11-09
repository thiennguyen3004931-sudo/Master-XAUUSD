export class NumberUtils {
  static clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
  }

  static round(value: number, digits = 2): number {
    const factor = 10 ** digits;
    return Math.round((value + Number.EPSILON) * factor) / factor;
  }

  static isFinitePositive(value: number | null | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  }
}
