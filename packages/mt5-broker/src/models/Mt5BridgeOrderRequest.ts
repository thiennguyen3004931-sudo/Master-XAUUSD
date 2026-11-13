export interface Mt5BridgeOrderRequest {
  symbol: string;
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT" | "STOP";
  timeInForce: "GTC" | "DAY" | "IOC" | "FOK";
  volume: number;
  requestedPrice: number;
  stopLoss: number;
  takeProfit: number;
  deviationPoints: number;
  magicNumber: number;
  comment: string;
  clientOrderId: string;
  idempotencyKey: string;
  expiresAt?: number;
}
