export class IdFactory {
  private sequence = 0;

  create(prefix: string, timestamp: number): string {
    this.sequence += 1;
    return `${prefix}-${timestamp}-${this.sequence}`;
  }
}
