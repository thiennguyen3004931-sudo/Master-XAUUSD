export class ValidationUtils {
  static isPositive(value: number): boolean {
    return Number.isFinite(value) && value > 0;
  }

  static hasValue<T>(value: T | null | undefined): value is T {
    return value !== null && value !== undefined;
  }

  static isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
  }
}
