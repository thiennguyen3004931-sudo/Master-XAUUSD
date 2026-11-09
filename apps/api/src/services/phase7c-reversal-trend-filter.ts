/**
 * Reversal trend context V2 (READ-ONLY SHADOW).
 *
 * Builds fully closed UTC-aligned H1/H4 candles from the SAME M15 feed as the
 * canonical regime classifier. Rejects incomplete groups and stale evidence.
 * This function never permits or sends a trading order. Its output is an
 * observation for evaluating a future, separately approved reversal strategy.
 */
const M15_MS = 15 * 60_000;

export type ReversalSide = "BUY" | "SELL";
export type TrendDirection = ReversalSide | "NEUTRAL";

export interface ClosedM15TrendBar {
  openTime: number;
  closeTime: number;
  close: number;
}

export interface TrendFrameEvidence {
  direction: TrendDirection;
  barCount: number;
  lastClosedAt: number | null;
  shortSma: number | null;
  longSma: number | null;
  longSmaSlope: number | null;
  stale: boolean;
}

function aggregateClosedM15(bars: readonly ClosedM15TrendBar[], frameMinutes: 60 | 240, now: number) {
  const count = frameMinutes / 15;
  const frameMs = frameMinutes * 60_000;
  const groups = new Map<number, ClosedM15TrendBar[]>();
  for (const bar of bars) {
    const open = Number(bar.openTime);
    const closeTime = Number(bar.closeTime);
    if (!Number.isFinite(open) || !Number.isFinite(closeTime) ||
        !Number.isFinite(bar.close) || closeTime <= open ||
        closeTime > now || closeTime - open > M15_MS) continue;
    const start = Math.floor(open / frameMs) * frameMs;
    if (open < start || open >= start + frameMs) continue;
    const group = groups.get(start) ?? [];
    group.push(bar);
    groups.set(start, group);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([start, group]) => {
      if (group.length !== count) return [];
      const sorted = group.sort((a, b) => a.openTime - b.openTime);
      const complete = sorted.every((bar, index) =>
        bar.openTime === start + index * M15_MS &&
        bar.closeTime === bar.openTime + M15_MS
      );
      if (!complete || start + frameMs > now) return [];
      return [{ close: sorted[count - 1]!.close, closeTime: start + frameMs }];
    });
}

function mean(closes: readonly number[]): number {
  return closes.reduce((sum, price) => sum + price, 0) / closes.length;
}

function assessFrame(
  candles: readonly { close: number; closeTime: number }[],
  shortPeriod: number,
  longPeriod: number,
  maxStalenessMs: number,
  now: number,
): TrendFrameEvidence {
  const end = candles.at(-1)?.closeTime ?? null;
  const stale = end === null || now - end > maxStalenessMs;
  const closes = candles.map((x) => x.close);
  if (closes.length < longPeriod + 2 || stale) {
    return { direction: "NEUTRAL", barCount: closes.length, lastClosedAt: end,
      shortSma: null, longSma: null, longSmaSlope: null, stale };
  }
  const shortSma = mean(closes.slice(-shortPeriod));
  const longSma = mean(closes.slice(-longPeriod));
  const previousLongSma = mean(closes.slice(-longPeriod - 2, -2));
  const longSmaSlope = longSma - previousLongSma;
  const lastClose = closes.at(-1)!;
  const direction: TrendDirection =
    shortSma > longSma && longSmaSlope > 0 && lastClose > longSma ? "BUY" :
    shortSma < longSma && longSmaSlope < 0 && lastClose < longSma ? "SELL" :
    "NEUTRAL";
  return { direction, barCount: closes.length, lastClosedAt: end, shortSma, longSma, longSmaSlope, stale };
}

export function assessReversalTrendFilter(
  candles: readonly ClosedM15TrendBar[],
  reversalSide: string | null,
  now = Date.now(),
) {
  const h1 = assessFrame(aggregateClosedM15(candles, 60, now), 9, 21, 2 * 60 * 60_000, now);
  const h4 = assessFrame(aggregateClosedM15(candles, 240, now), 5, 13, 8 * 60 * 60_000, now);
  const side = reversalSide === "BUY" || reversalSide === "SELL" ? reversalSide : null;
  const adequate = h1.shortSma !== null && h4.shortSma !== null;
  const status = !side ? "NO_REVERSAL_SIGNAL" :
    !adequate ? "INSUFFICIENT_OR_STALE_DATA" :
    (h1.direction === side && h4.direction === side) ? "CONFIRMED_H1_H4" :
    (h1.direction !== "NEUTRAL" && h1.direction !== side) ||
    (h4.direction !== "NEUTRAL" && h4.direction !== side) ? "COUNTER_TREND" :
    "WAIT_HIGHER_TIMEFRAME_CONFIRMATION";
  return {
    version: 2,
    source: "CLOSED_M15_AGGREGATED_H1_H4",
    signalSide: side,
    status,
    shadowEligible: status === "CONFIRMED_H1_H4",
    liveEntryPermission: false,
    tradingMutation: false,
    h1,
    h4,
  };
}
