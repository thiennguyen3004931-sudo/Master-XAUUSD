import type { PriceSource } from "./PriceSource";

export interface IndicatorConfig {
  smaPeriods: readonly number[];
  emaPeriods: readonly number[];
  atrPeriod: number;
  rsiPeriod: number;
  macdFastPeriod: number;
  macdSlowPeriod: number;
  macdSignalPeriod: number;
  bollingerPeriod: number;
  bollingerStandardDeviations: number;
  stochasticPeriod: number;
  stochasticSignalPeriod: number;
  adxPeriod: number;
  volumeSmaPeriod: number;
  priceSource: PriceSource;
}
