import type { Candle } from "@xauusd/market-data";
import { SwingType, Trend, type SwingPoint } from "@xauusd/types";
import type { StructureEvent } from "../models/StructureEvent";

export class StructureEventDetector {
  readonly name = "StructureEventDetector";

  detect(
    candles: readonly Candle[],
    swings: readonly SwingPoint[],
  ): StructureEvent[] {
    const events: StructureEvent[] = [];
    const brokenSwingIndexes = new Set<number>();
    let bias = Trend.Ranging;

    for (let candleIndex = 1; candleIndex < candles.length; candleIndex += 1) {
      const candle = candles[candleIndex]!;
      const availableSwings = swings.filter((swing) => swing.index < candleIndex);
      const latestHigh = availableSwings
        .filter((swing) => swing.type === SwingType.High)
        .at(-1);
      const latestLow = availableSwings
        .filter((swing) => swing.type === SwingType.Low)
        .at(-1);

      if (
        latestHigh &&
        !brokenSwingIndexes.has(latestHigh.index) &&
        candle.close > latestHigh.price
      ) {
        const direction = Trend.Bullish;
        events.push({
          id: `${bias === Trend.Bearish ? "CHOCH" : "BOS"}-BULL-${candle.openTime}`,
          type: bias === Trend.Bearish ? "CHOCH" : "BOS",
          direction,
          level: latestHigh.price,
          candleIndex,
          timestamp: candle.openTime,
          confirmed: true,
        });
        brokenSwingIndexes.add(latestHigh.index);
        bias = direction;
      }

      if (
        latestLow &&
        !brokenSwingIndexes.has(latestLow.index) &&
        candle.close < latestLow.price
      ) {
        const direction = Trend.Bearish;
        events.push({
          id: `${bias === Trend.Bullish ? "CHOCH" : "BOS"}-BEAR-${candle.openTime}`,
          type: bias === Trend.Bullish ? "CHOCH" : "BOS",
          direction,
          level: latestLow.price,
          candleIndex,
          timestamp: candle.openTime,
          confirmed: true,
        });
        brokenSwingIndexes.add(latestLow.index);
        bias = direction;
      }
    }

    return events;
  }
}
