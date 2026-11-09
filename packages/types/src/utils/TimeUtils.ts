export class TimeUtils {
  static now(): number {
    return Date.now();
  }

  static toDate(timestamp: number): Date {
    const date = new Date(timestamp);

    if (Number.isNaN(date.getTime())) {
      throw new RangeError("timestamp is invalid");
    }

    return date;
  }
}
