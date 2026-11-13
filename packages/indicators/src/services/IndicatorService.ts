import type { Candle } from "@xauusd/market-data";
import type { IndicatorConfig, IndicatorReport } from "../models";
import { IndicatorPipeline } from "./IndicatorPipeline";

export class IndicatorService {
  constructor(private readonly pipeline = new IndicatorPipeline()) {}

  calculate(
    candles: readonly Candle[],
    config: Partial<IndicatorConfig> = {},
  ): IndicatorReport {
    return this.pipeline.calculate(candles, config);
  }

  latest(
    candles: readonly Candle[],
    config: Partial<IndicatorConfig> = {},
  ): IndicatorReport["latest"] {
    return this.calculate(candles, config).latest;
  }
}
