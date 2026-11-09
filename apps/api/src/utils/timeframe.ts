import { Timeframe } from "@xauusd/market-data";

const durationByTimeframe: Record<Timeframe, number> = {
  [Timeframe.M1]: 60_000,
  [Timeframe.M5]: 5 * 60_000,
  [Timeframe.M15]: 15 * 60_000,
  [Timeframe.M30]: 30 * 60_000,
  [Timeframe.H1]: 60 * 60_000,
  [Timeframe.H4]: 4 * 60 * 60_000,
  [Timeframe.D1]: 24 * 60 * 60_000,
  [Timeframe.W1]: 7 * 24 * 60 * 60_000,
};

export function parseTimeframe(value: string): Timeframe {
  const normalized = value.trim().toUpperCase();
  const match = Object.values(Timeframe).find((item) => item === normalized);
  if (!match) throw new Error(`Unsupported timeframe: ${value}`);
  return match;
}

export function timeframeMs(timeframe: Timeframe): number {
  return durationByTimeframe[timeframe];
}
