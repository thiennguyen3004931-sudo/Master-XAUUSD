import type { Candle } from "../entities/Candle";
import type { Tick } from "../entities/Tick";
import type { Timeframe } from "../entities/Timeframe";
import type { IMarketDataProvider } from "../interfaces/IMarketDataProvider";

export abstract class BaseMarketDataProvider
  implements IMarketDataProvider
{
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract getCandles(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
  ): Promise<Candle[]>;
  abstract getLatestTick(symbol: string): Promise<Tick>;
  abstract subscribe(
    symbol: string,
    timeframe: Timeframe,
    onCandle: (candle: Candle) => void,
  ): Promise<void>;
}
