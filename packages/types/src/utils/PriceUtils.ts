export class PriceUtils {
  static distance(from: number, to: number): number {
    return Math.abs(to - from);
  }

  static riskReward(
    entry: number,
    stopLoss: number,
    takeProfit: number,
  ): number {
    const risk = Math.abs(entry - stopLoss);
    const reward = Math.abs(takeProfit - entry);

    return risk === 0 ? 0 : reward / risk;
  }
}
