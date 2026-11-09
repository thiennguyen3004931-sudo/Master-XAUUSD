export class StableJson {
  static stringify(value: unknown): string {
    return JSON.stringify(this.sort(value));
  }

  private static sort(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sort(item));
    }

    if (
      value !== null &&
      typeof value === "object"
    ) {
      const record = value as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .reduce<Record<string, unknown>>((result, key) => {
          result[key] = this.sort(record[key]);
          return result;
        }, {});
    }

    return value;
  }
}
