import type { Candle } from "../entities/Candle";
import type { Tick } from "../entities/Tick";
import type { Timeframe } from "../entities/Timeframe";
import type { ICandleRepository } from "../interfaces/ICandleRepository";
import type { IMarketDataProvider } from "../interfaces/IMarketDataProvider";

export class MarketDataService {
  constructor(
    private readonly provider: IMarketDataProvider,
    private readonly repository: ICandleRepository,
  ) {}

  connect(): Promise<void> {
    return this.provider.connect();
  }

  disconnect(): Promise<void> {
    return this.provider.disconnect();
  }

  async syncCandles(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
  ): Promise<Candle[]> {
    const candles = await this.provider.getCandles(symbol, timeframe, limit);
    await this.repository.saveMany(candles);
    return candles.map((candle) => ({ ...candle }));
  }

  async getCandles(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
    refresh = false,
  ): Promise<Candle[]> {
    if (refresh) {
      return this.syncCandles(symbol, timeframe, limit);
    }

    const cached = await this.repository.getHistory(symbol, timeframe, limit);
    if (cached.length >= limit) {
      return cached;
    }

    return this.syncCandles(symbol, timeframe, limit);
  }

  getLatestTick(symbol: string): Promise<Tick> {
    return this.provider.getLatestTick(symbol);
  }

  subscribe(
    symbol: string,
    timeframe: Timeframe,
    onCandle?: (candle: Candle) => void,
  ): Promise<void> {
    return this.provider.subscribe(symbol, timeframe, async (candle) => {
      await this.repository.save(candle);
      onCandle?.({ ...candle });
    });
  }
}
