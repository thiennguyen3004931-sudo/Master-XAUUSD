import type { Candle } from "../entities/Candle";
import type { Timeframe } from "../entities/Timeframe";
import type { ICandleRepository } from "../interfaces/ICandleRepository";

export class CandleService {
  constructor(private readonly repository: ICandleRepository) {}

  save(candle: Candle): Promise<void> {
    return this.repository.save(candle);
  }

  saveMany(candles: Candle[]): Promise<void> {
    return this.repository.saveMany(candles);
  }

  getLatest(symbol: string, timeframe: Timeframe): Promise<Candle | null> {
    return this.repository.getLatest(symbol, timeframe);
  }

  getHistory(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
  ): Promise<Candle[]> {
    return this.repository.getHistory(symbol, timeframe, limit);
  }

  clear(symbol: string, timeframe: Timeframe): Promise<void> {
    return this.repository.clear(symbol, timeframe);
  }
}
