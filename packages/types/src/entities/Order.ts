import type { OrderSide } from "../enums/OrderSide";

export interface Order {
  symbol: string;
  side: OrderSide;
  volume: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  comment?: string;
  clientOrderId?: string;
}
