import type { Candle } from "../entities/Candle";
import type { Tick } from "../entities/Tick";
import { Timeframe } from "../entities/Timeframe";
import { BaseMarketDataProvider } from "./BaseMarketDataProvider";

export interface MockProviderOptions {
  initialPrice?: number;
  spread?: number;
  seed?: number;
  now?: () => number;
}

export class MockProvider extends BaseMarketDataProvider {
  private connected = false;
  private readonly initialPrice: number;
  private readonly spread: number;
  private seed: number;
  private readonly now: () => number;

  constructor(options: MockProviderOptions = {}) {
    super();
    this.initialPrice = options.initialPrice ?? 3360;
    this.spread = options.spread ?? 0.3;
    this.seed = options.seed ?? 42;
    this.now = options.now ?? Date.now;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async getCandles(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
  ): Promise<Candle[]> {
    this.ensureConnected();

    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError("limit must be a positive integer");
    }

    const interval = this.timeframeMilliseconds(timeframe);
    const endTime = this.now();
    const candles: Candle[] = [];
    let price = this.initialPrice;

    for (let index = 0; index < limit; index += 1) {
      const open = price;
      const movement = (this.random() - 0.48) * 6;
      const close = Math.max(0.01, open + movement);
      const high = Math.max(open, close) + this.random() * 3;
      const low = Math.max(0.01, Math.min(open, close) - this.random() * 3);
      const openTime = endTime - (limit - index) * interval;

      candles.push({
        symbol: symbol.trim().toUpperCase(),
        timeframe,
        openTime,
        closeTime: openTime + interval - 1,
        open,
        high,
        low,
        close,
        volume: 1000 + this.random() * 1000,
        spread: this.spread,
      });

      price = close;
    }

    return candles;
  }

  async getLatestTick(symbol: string): Promise<Tick> {
    this.ensureConnected();
    const mid = this.initialPrice + (this.random() - 0.5) * 2;

    return {
      symbol: symbol.trim().toUpperCase(),
      bid: mid - this.spread / 2,
      ask: mid + this.spread / 2,
      last: mid,
      volume: 1000 + this.random() * 1000,
      timestamp: this.now(),
    };
  }

  async subscribe(
    _symbol: string,
    _timeframe: Timeframe,
    _onCandle: (candle: Candle) => void,
  ): Promise<void> {
    this.ensureConnected();
    // Mock subscriptions are intentionally passive. Test callers can fetch
    // deterministic candles through getCandles without background timers.
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error("MockProvider is not connected");
    }
  }

  private random(): number {
    this.seed = (1664525 * this.seed + 1013904223) >>> 0;
    return this.seed / 0x100000000;
  }

  private timeframeMilliseconds(timeframe: Timeframe): number {
    const minute = 60_000;
    const values: Record<Timeframe, number> = {
      [Timeframe.M1]: minute,
      [Timeframe.M5]: 5 * minute,
      [Timeframe.M15]: 15 * minute,
      [Timeframe.M30]: 30 * minute,
      [Timeframe.H1]: 60 * minute,
      [Timeframe.H4]: 4 * 60 * minute,
      [Timeframe.D1]: 24 * 60 * minute,
      [Timeframe.W1]: 7 * 24 * 60 * minute,
    };

    return values[timeframe];
  }
}
