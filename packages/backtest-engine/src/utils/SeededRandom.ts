export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state += 0x6d2b79f5;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value +
      Math.imul(value ^ (value >>> 7), value | 61);
    return (
      ((value ^ (value >>> 14)) >>> 0) /
      4_294_967_296
    );
  }

  integer(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0;
    return Math.floor(this.next() * maxExclusive);
  }
}
