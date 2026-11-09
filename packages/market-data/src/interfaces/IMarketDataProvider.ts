import type { MarketDataProvider } from "@xauusd/types";
import type { Candle } from "../entities/Candle";
import type { Tick } from "../entities/Tick";
import type { Timeframe } from "../entities/Timeframe";

export interface IMarketDataProvider
  extends MarketDataProvider<string, Timeframe, Candle> {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getLatestTick(symbol: string): Promise<Tick>;
  subscribe(
    symbol: string,
    timeframe: Timeframe,
    onCandle: (candle: Candle) => void,
  ): Promise<void>;
}
