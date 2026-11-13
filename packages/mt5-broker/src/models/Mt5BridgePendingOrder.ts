export interface Mt5BridgePendingOrder {
  ticket: string;
  symbol: string;
  brokerSymbol: string;
  type: number;
  volume: number;
  price: number;
  magic: number;
  comment: string;
}
