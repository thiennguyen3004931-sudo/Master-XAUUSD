import type { IndicatorConfig } from "../models";
import { NumberUtils } from "../utils";

export class IndicatorConfigValidator {
  validate(config: IndicatorConfig): void {
    this.validatePeriods(config.smaPeriods, "smaPeriods");
    this.validatePeriods(config.emaPeriods, "emaPeriods");
    NumberUtils.assertPositiveInteger(config.atrPeriod, "atrPeriod");
    NumberUtils.assertPositiveInteger(config.rsiPeriod, "rsiPeriod");
    NumberUtils.assertPositiveInteger(config.macdFastPeriod, "macdFastPeriod");
    NumberUtils.assertPositiveInteger(config.macdSlowPeriod, "macdSlowPeriod");
    NumberUtils.assertPositiveInteger(config.macdSignalPeriod, "macdSignalPeriod");
    NumberUtils.assertPositiveInteger(config.bollingerPeriod, "bollingerPeriod");
    NumberUtils.assertPositive(
      config.bollingerStandardDeviations,
      "bollingerStandardDeviations",
    );
    NumberUtils.assertPositiveInteger(config.stochasticPeriod, "stochasticPeriod");
    NumberUtils.assertPositiveInteger(
      config.stochasticSignalPeriod,
      "stochasticSignalPeriod",
    );
    NumberUtils.assertPositiveInteger(config.adxPeriod, "adxPeriod");
    NumberUtils.assertPositiveInteger(config.volumeSmaPeriod, "volumeSmaPeriod");

    if (config.macdFastPeriod >= config.macdSlowPeriod) {
      throw new RangeError("macdFastPeriod must be less than macdSlowPeriod");
    }
  }

  private validatePeriods(periods: readonly number[], name: string): void {
    if (periods.length === 0) {
      throw new RangeError(`${name} must contain at least one period`);
    }

    const unique = new Set<number>();
    periods.forEach((period) => {
      NumberUtils.assertPositiveInteger(period, `${name} value`);
      if (unique.has(period)) {
        throw new RangeError(`${name} must not contain duplicate periods`);
      }
      unique.add(period);
    });
  }
}
