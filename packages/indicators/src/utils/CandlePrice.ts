import type { Candle } from "@xauusd/market-data";
import type { PriceSource } from "../models/PriceSource";

export const candlePrice = (candle: Candle, source: PriceSource): number => {
  switch (source) {
    case "open":
      return candle.open;
    case "high":
      return candle.high;
    case "low":
      return candle.low;
    case "close":
      return candle.close;
    case "hl2":
      return (candle.high + candle.low) / 2;
    case "hlc3":
      return (candle.high + candle.low + candle.close) / 3;
    case "ohlc4":
      return (candle.open + candle.high + candle.low + candle.close) / 4;
  }
};

export const candlePrices = (
  candles: readonly Candle[],
  source: PriceSource,
): number[] => candles.map((candle) => candlePrice(candle, source));
