import type { IndicatorConfig } from "../models/IndicatorConfig";

export const defaultIndicatorConfig: Readonly<IndicatorConfig> = {
  smaPeriods: [20, 50, 200],
  emaPeriods: [9, 20, 21, 50, 200],
  atrPeriod: 14,
  rsiPeriod: 14,
  macdFastPeriod: 12,
  macdSlowPeriod: 26,
  macdSignalPeriod: 9,
  bollingerPeriod: 20,
  bollingerStandardDeviations: 2,
  stochasticPeriod: 14,
  stochasticSignalPeriod: 3,
  adxPeriod: 14,
  volumeSmaPeriod: 20,
  priceSource: "close",
};
