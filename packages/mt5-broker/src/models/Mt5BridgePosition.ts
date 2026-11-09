export interface Mt5BridgePosition {
  ticket: string;
  symbol: string;
  brokerSymbol: string;
  side: "LONG" | "SHORT";
  volume: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  profit: number;
  swap: number;
  commission: number;
  openedAt?: number;
  magic?: number;
  comment?: string;
}
