import { OrderSide } from "@xauusd/types";
import { NumberUtils } from "./NumberUtils";

export class TradeMath {
  static grossPnl(
    side: OrderSide,
    entryPrice: number,
    exitPrice: number,
    volume: number,
    contractSize: number,
  ): number {
    const priceMove =
      side === OrderSide.BUY
        ? exitPrice - entryPrice
        : entryPrice - exitPrice;
    return NumberUtils.round(
      priceMove * volume * contractSize,
    );
  }

  static unrealizedPnl(
    side: OrderSide,
    entryPrice: number,
    currentPrice: number,
    volume: number,
    contractSize: number,
  ): number {
    return this.grossPnl(
      side,
      entryPrice,
      currentPrice,
      volume,
      contractSize,
    );
  }

  static riskMultiple(
    side: OrderSide,
    entryPrice: number,
    initialStopLoss: number,
    currentPrice: number,
  ): number {
    const risk = Math.abs(entryPrice - initialStopLoss);
    if (risk <= 0) return 0;
    const reward =
      side === OrderSide.BUY
        ? currentPrice - entryPrice
        : entryPrice - currentPrice;
    return reward / risk;
  }

  static floorVolume(
    value: number,
    step: number,
  ): number {
    if (!Number.isFinite(value) || step <= 0) return 0;
    return NumberUtils.round(
      Math.floor((value + Number.EPSILON) / step) * step,
    );
  }

  static oppositeSide(side: OrderSide): OrderSide {
    return side === OrderSide.BUY
      ? OrderSide.SELL
      : OrderSide.BUY;
  }
}
