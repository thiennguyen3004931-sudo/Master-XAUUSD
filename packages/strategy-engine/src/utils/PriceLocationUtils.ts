import { SignalType } from "@xauusd/types";
import type { DetailedAnalysisResult } from "@xauusd/analysis-engine";

export class PriceLocationUtils {
  static isFavorable(
    signal: SignalType,
    close: number,
    analysis: DetailedAnalysisResult,
  ): boolean {
    if (signal === SignalType.BUY) {
      return close <= analysis.equilibrium || close <= analysis.discountZone;
    }
    if (signal === SignalType.SELL) {
      return close >= analysis.equilibrium || close >= analysis.premiumZone;
    }
    return false;
  }
}
