import type { Candle } from "@xauusd/market-data";
import type { OrderBlock } from "@xauusd/types";
import type { OrderBlockDetectionConfig } from "../config/AnalysisConfig";
import { CandleUtils } from "../utils/CandleUtils";

export class OrderBlockDetector {
  readonly name = "OrderBlockDetector";

  detect(
    candles: readonly Candle[],
    config: OrderBlockDetectionConfig,
  ): OrderBlock[] {
    const blocks: OrderBlock[] = [];

    for (let index = 1; index < candles.length; index += 1) {
      const displacement = candles[index]!;
      const start = Math.max(0, index - config.atrPeriod);
      const atr = CandleUtils.averageTrueRange(
        candles.slice(start, index + 1),
        config.atrPeriod,
      );

      if (atr <= 0 || CandleUtils.body(displacement) < atr * config.displacementMultiplier) {
        continue;
      }

      const bullishDisplacement = CandleUtils.isBullish(displacement);
      const bearishDisplacement = CandleUtils.isBearish(displacement);

      if (!bullishDisplacement && !bearishDisplacement) {
        continue;
      }

      const origin = this.findOriginCandle(
        candles,
        index,
        bullishDisplacement,
        config.lookback,
      );

      if (!origin) {
        continue;
      }

      const laterCandles = candles.slice(index + 1);
      const mitigated = bullishDisplacement
        ? laterCandles.some((candle) => candle.low <= origin.candle.high)
        : laterCandles.some((candle) => candle.high >= origin.candle.low);

      blocks.push({
        id: `OB-${bullishDisplacement ? "BULL" : "BEAR"}-${origin.candle.openTime}`,
        high: origin.candle.high,
        low: origin.candle.low,
        bullish: bullishDisplacement,
        mitigated,
        createdAt: displacement.openTime,
      });
    }

    const unique = new Map<string, OrderBlock>();
    for (const block of blocks) {
      unique.set(block.id ?? `${block.createdAt}-${block.high}-${block.low}`, block);
    }

    return [...unique.values()].slice(-config.maxZones);
  }

  private findOriginCandle(
    candles: readonly Candle[],
    displacementIndex: number,
    bullishDisplacement: boolean,
    lookback: number,
  ): { candle: Candle; index: number } | null {
    const start = Math.max(0, displacementIndex - lookback);

    for (let index = displacementIndex - 1; index >= start; index -= 1) {
      const candle = candles[index]!;
      const isOpposite = bullishDisplacement
        ? CandleUtils.isBearish(candle)
        : CandleUtils.isBullish(candle);

      if (isOpposite) {
        return { candle, index };
      }
    }

    return null;
  }
}
