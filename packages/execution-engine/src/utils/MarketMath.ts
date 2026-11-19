import { OrderSide, PositionSide } from "@xauusd/types";
import { NumberUtils } from "./NumberUtils";

export class MarketMath {
  static executablePrice(
    side: OrderSide,
    bid: number,
    ask: number,
  ): number {
    return side === OrderSide.BUY ? ask : bid;
  }

  static normalizePrice(
    value: number,
    tickSize: number,
    digits: number,
  ): number {
    if (!Number.isFinite(value) || tickSize <= 0) return 0;
    return NumberUtils.round(
      Math.round(value / tickSize) * tickSize,
      digits,
    );
  }

  static floorVolume(
    value: number,
    step: number,
    digits = 8,
  ): number {
    if (!Number.isFinite(value) || step <= 0) return 0;
    return NumberUtils.round(
      Math.floor((value + Number.EPSILON) / step) * step,
      digits,
    );
  }

  static isLong(side: PositionSide): boolean {
    return side === PositionSide.LONG;
  }

  static currentExitPrice(
    side: PositionSide,
    bid: number,
    ask: number,
  ): number {
    return this.isLong(side) ? bid : ask;
  }

  static hasReachedTarget(
    side: PositionSide,
    currentPrice: number,
    target: number,
  ): boolean {
    return this.isLong(side)
      ? currentPrice >= target
      : currentPrice <= target;
  }

  static riskMultiple(
    side: PositionSide,
    entry: number,
    initialStopLoss: number,
    currentPrice: number,
  ): number {
    const risk = Math.abs(entry - initialStopLoss);
    if (risk <= 0) return 0;
    const reward = this.isLong(side)
      ? currentPrice - entry
      : entry - currentPrice;
    return reward / risk;
  }
}
