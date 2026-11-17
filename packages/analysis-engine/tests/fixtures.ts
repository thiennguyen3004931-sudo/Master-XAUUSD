import { Timeframe, type Candle } from "@xauusd/market-data";

export function createCandle(
  index: number,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  const openTime = 1_700_000_000_000 + index * 60_000;

  return {
    symbol: "XAUUSD",
    timeframe: Timeframe.M1,
    openTime,
    closeTime: openTime + 59_999,
    open,
    high,
    low,
    close,
    volume: 1000 + index,
  };
}

export function createTrendingCandles(count = 40): Candle[] {
  const candles: Candle[] = [];
  let price = 2300;

  for (let index = 0; index < count; index += 1) {
    const wave = Math.sin(index / 2) * 2;
    const open = price;
    const close = price + 0.7 + wave * 0.2;
    const high = Math.max(open, close) + 1 + Math.max(0, wave);
    const low = Math.min(open, close) - 1 + Math.min(0, wave);
    candles.push(createCandle(index, open, high, low, close));
    price = close;
  }

  return candles;
}
