import type { Order } from "@xauusd/types";
import type {
  ExecutionOrderType,
  NormalizedExecutionOrder,
  SymbolExecutionSpec,
  TimeInForce,
} from "../models";
import { MarketMath } from "../utils";

export class OrderNormalizationService {
  normalize(
    order: Order,
    spec: SymbolExecutionSpec,
    idempotencyKey: string,
    orderType: ExecutionOrderType,
    timeInForce: TimeInForce,
    expiresAt?: number,
  ): NormalizedExecutionOrder {
    const clientOrderId =
      order.clientOrderId?.trim() || idempotencyKey;

    return {
      original: { ...order },
      symbol: order.symbol,
      side: order.side,
      orderType,
      timeInForce,
      volume: MarketMath.floorVolume(
        Math.min(order.volume, spec.maxVolume),
        spec.volumeStep,
      ),
      requestedPrice: MarketMath.normalizePrice(
        order.entry,
        spec.tickSize,
        spec.digits,
      ),
      stopLoss: MarketMath.normalizePrice(
        order.stopLoss,
        spec.tickSize,
        spec.digits,
      ),
      takeProfit: MarketMath.normalizePrice(
        order.takeProfit,
        spec.tickSize,
        spec.digits,
      ),
      clientOrderId,
      idempotencyKey,
      expiresAt,
    };
  }
}
