import { OrderSide, SignalType, type Order } from "@xauusd/types";
import type { PositionSizing, RiskContext } from "../models";

export class RiskOrderFactory {
  create(context: RiskContext, sizing: PositionSizing): Order {
    const signal = context.signalResult.signal;
    if (!signal) {
      throw new Error("Cannot create an order without an accepted signal.");
    }

    if (signal.type !== SignalType.BUY && signal.type !== SignalType.SELL) {
      throw new Error("Only BUY and SELL signals can become orders.");
    }

    return {
      symbol: signal.symbol,
      side:
        signal.type === SignalType.BUY
          ? OrderSide.BUY
          : OrderSide.SELL,
      volume: sizing.volume,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      comment: `risk-approved:${signal.timeframe}:${signal.confidence.toFixed(2)}`,
      clientOrderId: `xau-${signal.createdAt}-${signal.type.toLowerCase()}`,
    };
  }
}
