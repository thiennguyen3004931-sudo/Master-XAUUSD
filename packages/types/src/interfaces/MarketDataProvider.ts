export interface MarketDataProvider<
  TSymbol = string,
  TTimeframe = string,
  TCandle = unknown,
> {
  getCandles(
    symbol: TSymbol,
    timeframe: TTimeframe,
    limit: number,
  ): Promise<TCandle[]>;
}
