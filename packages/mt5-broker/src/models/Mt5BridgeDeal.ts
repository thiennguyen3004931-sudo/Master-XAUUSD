export interface Mt5BridgeDeal {
  ticket: string;
  orderId: string;
  positionId: string;
  symbol: string;
  side: "BUY" | "SELL" | null;
  entry: "IN" | "OUT" | "INOUT" | "OUT_BY" | "UNKNOWN";
  volume: number;
  price: number;
  profit: number;
  commission: number;
  swap: number;
  fee: number;
  netPnl: number;
  magic: number;
  comment: string;
  timestamp: number;
  isTradingDeal: boolean;
}
