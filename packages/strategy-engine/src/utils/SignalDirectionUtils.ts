import { MarketStructure, SignalType, Trend } from "@xauusd/types";

export class SignalDirectionUtils {
  static matchesTrend(signal: SignalType, trend: Trend): boolean {
    return (
      (signal === SignalType.BUY && trend === Trend.Bullish) ||
      (signal === SignalType.SELL && trend === Trend.Bearish)
    );
  }

  static matchesStructure(signal: SignalType, structure: MarketStructure): boolean {
    return (
      (signal === SignalType.BUY && structure === MarketStructure.Bullish) ||
      (signal === SignalType.SELL && structure === MarketStructure.Bearish)
    );
  }

  static isDirectional(signal: SignalType): boolean {
    return signal === SignalType.BUY || signal === SignalType.SELL;
  }
}
