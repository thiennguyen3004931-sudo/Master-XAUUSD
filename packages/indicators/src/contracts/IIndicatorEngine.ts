import type { Candle } from "@xauusd/market-data";
import type { IndicatorConfig, IndicatorReport } from "../models";

export interface IIndicatorEngine {
  calculate(
    candles: readonly Candle[],
    config?: Partial<IndicatorConfig>,
  ): IndicatorReport;
}
