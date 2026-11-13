import type { OrderSide } from "@xauusd/types";

export interface BacktestPositionSnapshot {
  id: string;
  symbol: string;
  side: OrderSide;
  entryTime: number;
  entryPrice: number;
  volume: number;
  stopLoss: number;
  takeProfit: number;
  unrealizedPnl: number;
}
