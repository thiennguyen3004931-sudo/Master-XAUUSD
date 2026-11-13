export interface Mt5BridgeTradingDayBoundary {
  symbol: string;
  brokerSymbol: string;
  currentStartTime: number;
  previousStartTime: number | null;
  source: "MT5_D1_CURRENT_BAR";
}
