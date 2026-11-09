import type { Order } from "@xauusd/types";
import type { ExecutionOrderType } from "./ExecutionOrderType";
import type { TimeInForce } from "./TimeInForce";

export interface NormalizedExecutionOrder {
  original: Order;
  symbol: string;
  side: Order["side"];
  orderType: ExecutionOrderType;
  timeInForce: TimeInForce;
  volume: number;
  requestedPrice: number;
  stopLoss: number;
  takeProfit: number;
  clientOrderId: string;
  idempotencyKey: string;
  expiresAt?: number;
}
