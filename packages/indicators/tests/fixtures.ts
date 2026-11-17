import { Timeframe, type Candle } from "@xauusd/market-data";

export const createCandles = (
  count = 240,
  transform: (index: number) => number = (index) => 2300 + (index * 0.5),
): Candle[] => Array.from({ length: count }, (_, index) => {
  const close = transform(index);
  const open = close - 0.2;

  return {
    symbol: "XAUUSD",
    timeframe: Timeframe.M15,
    openTime: index * 900_000,
    closeTime: ((index + 1) * 900_000) - 1,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 100 + index,
  };
});
