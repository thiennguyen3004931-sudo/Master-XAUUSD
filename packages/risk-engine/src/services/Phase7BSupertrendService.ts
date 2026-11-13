import type { Phase7Bar, Phase7Side } from "../models/Phase7TrendRider";

export interface Phase7BSupertrendResult {
  line: Array<number | null>;
  direction: Array<Phase7Side | null>;
}

export function phase7BSupertrend(
  bars: readonly Phase7Bar[],
  period = 10,
  multiplier = 3,
): Phase7BSupertrendResult {
  if (!Number.isInteger(period) || period < 2) {
    throw new Error("phase7BSupertrend period must be an integer >= 2.");
  }
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error("phase7BSupertrend multiplier must be > 0.");
  }

  const n = bars.length;
  const tr: number[] = Array(n).fill(0);
  const atr: Array<number | null> = Array(n).fill(null);
  const upper: Array<number | null> = Array(n).fill(null);
  const lower: Array<number | null> = Array(n).fill(null);
  const line: Array<number | null> = Array(n).fill(null);
  const direction: Array<Phase7Side | null> = Array(n).fill(null);

  for (let i = 0; i < n; i += 1) {
    const bar = bars[i]!;
    const prevClose = i > 0 ? bars[i - 1]!.close : bar.close;
    tr[i] = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - prevClose),
      Math.abs(bar.low - prevClose),
    );

    if (i === period - 1) {
      atr[i] = tr.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    } else if (i >= period) {
      atr[i] = ((atr[i - 1]! * (period - 1)) + tr[i]!) / period;
    }
    if (atr[i] === null) continue;

    const mid = (bar.high + bar.low) / 2;
    const basicUpper = mid + multiplier * atr[i]!;
    const basicLower = mid - multiplier * atr[i]!;

    if (i === period - 1 || upper[i - 1] === null || lower[i - 1] === null) {
      upper[i] = basicUpper;
      lower[i] = basicLower;
      line[i] = bar.close <= upper[i]! ? upper[i] : lower[i]!;
      direction[i] = line[i] === lower[i] ? "BUY" : "SELL";
      continue;
    }

    upper[i] = basicUpper < upper[i - 1]! || bars[i - 1]!.close > upper[i - 1]!
      ? basicUpper
      : upper[i - 1];
    lower[i] = basicLower > lower[i - 1]! || bars[i - 1]!.close < lower[i - 1]!
      ? basicLower
      : lower[i - 1];

    if (line[i - 1] === upper[i - 1]) {
      line[i] = bar.close <= upper[i]! ? upper[i] : lower[i]!;
    } else {
      line[i] = bar.close >= lower[i]! ? lower[i] : upper[i]!;
    }
    direction[i] = line[i] === lower[i] ? "BUY" : "SELL";
  }

  return { line, direction };
}
