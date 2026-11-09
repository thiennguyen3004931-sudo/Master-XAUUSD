export class MathUtils {
  static round(value: number, digits = 2): number {
    if (!Number.isFinite(value)) {
      throw new RangeError("value must be finite");
    }

    if (!Number.isInteger(digits) || digits < 0 || digits > 12) {
      throw new RangeError("digits must be an integer between 0 and 12");
    }

    const factor = 10 ** digits;
    return Math.round((value + Number.EPSILON) * factor) / factor;
  }

  static clamp(value: number, min: number, max: number): number {
    if (min > max) {
      throw new RangeError("min cannot be greater than max");
    }

    return Math.min(max, Math.max(min, value));
  }
}
