import type { Candle } from "@xauusd/market-data";
import { Timeframe } from "@xauusd/market-data";
import { timeframeMs } from "../utils/timeframe";
import { round } from "../utils/number";

export interface MarketQuote {
  symbol: string;
  bid: number;
  ask: number;
  spread: number;
  high: number;
  low: number;
  session: string;
  volatility: number;
  time: string;
}

export class MockProvider {
  async getCandles(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
    endTime = Date.now(),
    spread = 0.2,
  ): Promise<Candle[]> {
    const boundedLimit = Math.max(20, Math.min(5_000, Math.floor(limit)));
    const duration = timeframeMs(timeframe);
    const alignedEnd = Math.floor(endTime / duration) * duration;
    const seed = this.hash(`${symbol}:${timeframe}:${Math.floor(alignedEnd / duration)}`);
    const random = this.random(seed);
    const candles: Candle[] = [];
    let close = 2385 + (seed % 35);

    for (let index = 0; index < boundedLimit; index += 1) {
      const openTime = alignedEnd - (boundedLimit - index) * duration;
      const open = close;
      const trend = 0.035 + Math.sin(index / 41) * 0.025;
      const cycle = Math.sin(index / 8.5) * 0.75 + Math.sin(index / 21) * 1.15;
      const noise = (random() - 0.5) * 1.6;
      close = open + trend + cycle * 0.12 + noise;
      const wick = 0.45 + random() * 1.2;
      const high = Math.max(open, close) + wick;
      const low = Math.min(open, close) - wick * (0.8 + random() * 0.4);

      candles.push({
        symbol: symbol.toUpperCase(),
        timeframe,
        openTime,
        closeTime: openTime + duration,
        open: round(open),
        high: round(high),
        low: round(low),
        close: round(close),
        volume: round(800 + random() * 900, 0),
        spread: round(spread, 2),
      });
    }

    return candles;
  }

  async getQuote(symbol: string): Promise<MarketQuote> {
    const candles = await this.getCandles(symbol, Timeframe.M15, 64);
    const last = candles.at(-1)!;
    const sessionHour = new Date().getUTCHours();
    const session =
      sessionHour >= 12 && sessionHour < 16
        ? "OVERLAP"
        : sessionHour >= 7 && sessionHour < 16
          ? "LONDON"
          : sessionHour >= 12 && sessionHour < 21
            ? "NEW_YORK"
            : sessionHour < 9
              ? "ASIAN"
              : "CLOSED";
    const spread = last.spread ?? 0.2;
    return {
      symbol: last.symbol,
      bid: round(last.close - spread / 2),
      ask: round(last.close + spread / 2),
      spread,
      high: Math.max(...candles.slice(-32).map((item) => item.high)),
      low: Math.min(...candles.slice(-32).map((item) => item.low)),
      session,
      volatility: round((last.high - last.low) / last.close * 100, 3),
      time: new Date(last.closeTime).toISOString(),
    };
  }

  private hash(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  private random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state += 0x6d2b79f5;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
  }
}
