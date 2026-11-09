export class TextSanitizer {
  sanitize(
    value: string,
    maximumLength: number
  ): string {
    return value
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maximumLength);
  }

  sanitizeMany(
    values: readonly string[],
    maximumItems: number,
    maximumLength: number
  ): string[] {
    return values
      .slice(0, maximumItems)
      .map((value) => this.sanitize(value, maximumLength))
      .filter((value) => value.length > 0);
  }
}
