import { Timeframe } from "@xauusd/market-data";
import { MockProvider } from "../providers/mock.provider";

const provider = new MockProvider();

export function getQuote(symbol = "XAUUSD") {
  return provider.getQuote(symbol);
}

export function getCandles(
  symbol: string,
  timeframe: Timeframe,
  limit: number,
  endTime?: number,
  spread?: number,
) {
  return provider.getCandles(symbol, timeframe, limit, endTime, spread);
}
