import type { Candle } from "@xauusd/market-data";

export interface PremiumDiscountResult {
  premiumZone: number;
  discountZone: number;
  equilibrium: number;
  rangeHigh: number;
  rangeLow: number;
}

export class PremiumDiscountDetector {
  readonly name = "PremiumDiscountDetector";

  detect(candles: readonly Candle[]): PremiumDiscountResult {
    if (candles.length === 0) {
      return {
        premiumZone: 0,
        discountZone: 0,
        equilibrium: 0,
        rangeHigh: 0,
        rangeLow: 0,
      };
    }

    const rangeHigh = Math.max(...candles.map((candle) => candle.high));
    const rangeLow = Math.min(...candles.map((candle) => candle.low));
    const range = rangeHigh - rangeLow;

    return {
      premiumZone: rangeLow + range * 0.75,
      discountZone: rangeLow + range * 0.25,
      equilibrium: rangeLow + range * 0.5,
      rangeHigh,
      rangeLow,
    };
  }
}
