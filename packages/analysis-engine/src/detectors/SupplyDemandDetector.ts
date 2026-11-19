import type { Candle } from "@xauusd/market-data";
import type { SupplyDemandDetectionConfig } from "../config/AnalysisConfig";
import type { SupplyDemandZone } from "../models/SupplyDemandZone";
import { CandleUtils } from "../utils/CandleUtils";

export class SupplyDemandDetector {
  readonly name = "SupplyDemandDetector";

  detect(
    candles: readonly Candle[],
    config: SupplyDemandDetectionConfig,
  ): SupplyDemandZone[] {
    const zones: SupplyDemandZone[] = [];

    for (let index = 1; index < candles.length; index += 1) {
      const displacement = candles[index]!;
      const atrStart = Math.max(0, index - config.atrPeriod);
      const atr = CandleUtils.averageTrueRange(
        candles.slice(atrStart, index + 1),
        config.atrPeriod,
      );

      if (
        atr <= 0 ||
        CandleUtils.body(displacement) < atr * config.displacementMultiplier
      ) {
        continue;
      }

      const bullish = CandleUtils.isBullish(displacement);
      const bearish = CandleUtils.isBearish(displacement);

      if (!bullish && !bearish) {
        continue;
      }

      const origin = this.findOrigin(
        candles,
        index,
        bullish,
        config.lookback,
      );

      if (!origin) {
        continue;
      }

      const type = bullish ? "DEMAND" as const : "SUPPLY" as const;
      const low = origin.candle.low;
      const high = origin.candle.high;
      const later = candles.slice(index + 1);

      const touched = later.some(
        (candle) => candle.high >= low && candle.low <= high,
      );

      const broken = type === "DEMAND"
        ? later.some((candle) => candle.close < low)
        : later.some((candle) => candle.close > high);

      const displacementRatio = CandleUtils.body(displacement) / atr;
      const strength = Math.max(
        1,
        Math.min(5, Math.round(displacementRatio * 2)),
      );

      zones.push({
        id: `SD-${type}-${origin.candle.openTime}`,
        type,
        low,
        high,
        strength,
        active: !broken,
        touched,
        createdAt: displacement.openTime,
      });
    }

    const unique = new Map<string, SupplyDemandZone>();

    for (const zone of zones) {
      unique.set(zone.id, zone);
    }

    return [...unique.values()].slice(-config.maxZones);
  }

  private findOrigin(
    candles: readonly Candle[],
    displacementIndex: number,
    bullishDisplacement: boolean,
    lookback: number,
  ): { candle: Candle; index: number } | null {
    const start = Math.max(0, displacementIndex - lookback);

    for (
      let index = displacementIndex - 1;
      index >= start;
      index -= 1
    ) {
      const candle = candles[index]!;
      const opposite = bullishDisplacement
        ? CandleUtils.isBearish(candle)
        : CandleUtils.isBullish(candle);

      if (opposite) {
        return { candle, index };
      }
    }

    return null;
  }
}