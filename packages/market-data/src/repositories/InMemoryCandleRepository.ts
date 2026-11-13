import type { Candle } from "../entities/Candle";
import type { Timeframe } from "../entities/Timeframe";
import type { ICandleRepository } from "../interfaces/ICandleRepository";

export class InMemoryCandleRepository implements ICandleRepository {
  private readonly storage = new Map<string, Candle[]>();

  private key(symbol: string, timeframe: Timeframe): string {
    return `${symbol.trim().toUpperCase()}:${timeframe}`;
  }

  async save(candle: Candle): Promise<void> {
    this.validateCandle(candle);

    const key = this.key(candle.symbol, candle.timeframe);
    const candles = this.storage.get(key) ?? [];
    const index = candles.findIndex(
      (existing) => existing.openTime === candle.openTime,
    );

    const stored = { ...candle };

    if (index >= 0) {
      candles[index] = stored;
    } else {
      candles.push(stored);
    }

    candles.sort((left, right) => left.openTime - right.openTime);
    this.storage.set(key, candles);
  }

  async saveMany(candles: Candle[]): Promise<void> {
    for (const candle of candles) {
      await this.save(candle);
    }
  }

  async getLatest(
    symbol: string,
    timeframe: Timeframe,
  ): Promise<Candle | null> {
    const candles = this.storage.get(this.key(symbol, timeframe));
    const latest = candles?.at(-1);
    return latest ? { ...latest } : null;
  }

  async getHistory(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
  ): Promise<Candle[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError("limit must be a positive integer");
    }

    const candles = this.storage.get(this.key(symbol, timeframe)) ?? [];
    return candles.slice(-limit).map((candle) => ({ ...candle }));
  }

  async clear(symbol: string, timeframe: Timeframe): Promise<void> {
    this.storage.delete(this.key(symbol, timeframe));
  }

  private validateCandle(candle: Candle): void {
    if (!candle.symbol.trim()) {
      throw new Error("candle.symbol is required");
    }

    const prices = [candle.open, candle.high, candle.low, candle.close];
    if (prices.some((price) => !Number.isFinite(price) || price <= 0)) {
      throw new Error("candle prices must be positive finite numbers");
    }

    if (candle.high < Math.max(candle.open, candle.close, candle.low)) {
      throw new Error("candle.high is inconsistent with OHLC values");
    }

    if (candle.low > Math.min(candle.open, candle.close, candle.high)) {
      throw new Error("candle.low is inconsistent with OHLC values");
    }

    if (candle.closeTime < candle.openTime) {
      throw new Error("candle.closeTime must be greater than openTime");
    }

    if (!Number.isFinite(candle.volume) || candle.volume < 0) {
      throw new Error("candle.volume must be a non-negative finite number");
    }
  }
}
