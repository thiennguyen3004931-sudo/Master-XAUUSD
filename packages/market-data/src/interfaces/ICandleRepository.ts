import type { Candle } from "../entities/Candle";
import type { Timeframe } from "../entities/Timeframe";

export interface ICandleRepository {
  save(candle: Candle): Promise<void>;
  saveMany(candles: Candle[]): Promise<void>;
  getLatest(symbol: string, timeframe: Timeframe): Promise<Candle | null>;
  getHistory(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
  ): Promise<Candle[]>;
  clear(symbol: string, timeframe: Timeframe): Promise<void>;
}
