import type {
  InstrumentRiskSpec,
  PositionSizing,
  RiskBudget,
} from "../models";
import { NumberUtils, VolumeUtils } from "../utils";

export class PositionSizeService {
  calculate(
    entry: number,
    stopLoss: number,
    equity: number,
    budget: RiskBudget,
    instrument: InstrumentRiskSpec,
    fixedLot?: number,
  ): PositionSizing {
    if (typeof fixedLot === "number" && Number.isFinite(fixedLot) && fixedLot > 0) {
      const stopDistance = Math.abs(entry - stopLoss);
      const stopTicks = instrument.tickSize > 0 ? stopDistance / instrument.tickSize : 0;
      const riskPerLot = stopTicks * instrument.tickValuePerLot;
      const actualRiskAmount = fixedLot * riskPerLot;
      return {
        entry,
        stopLoss,
        stopDistance: NumberUtils.round(stopDistance),
        stopTicks: NumberUtils.round(stopTicks),
        riskPerLot: NumberUtils.round(riskPerLot),
        rawVolume: fixedLot,
        volume: fixedLot,
        actualRiskAmount: NumberUtils.round(actualRiskAmount),
        actualRiskPercent: NumberUtils.round(NumberUtils.percentOf(actualRiskAmount, equity)),
        cappedAtMaximum: fixedLot > instrument.maxVolume,
        belowMinimum: fixedLot < instrument.minVolume,
      };
    }
    const stopDistance = Math.abs(entry - stopLoss);
    const stopTicks =
      instrument.tickSize > 0 ? stopDistance / instrument.tickSize : 0;
    const riskPerLot = stopTicks * instrument.tickValuePerLot;
    const rawVolume =
      riskPerLot > 0 ? budget.approvedRiskAmount / riskPerLot : 0;

    const belowMinimum = rawVolume < instrument.minVolume;
    const cappedAtMaximum = rawVolume > instrument.maxVolume;
    const boundedVolume = Math.min(rawVolume, instrument.maxVolume);
    const volume = belowMinimum
      ? 0
      : VolumeUtils.floorToStep(
          boundedVolume,
          instrument.volumeStep,
          instrument.priceDigits ?? 8,
        );

    const actualRiskAmount = volume * riskPerLot;
    const actualRiskPercent = NumberUtils.percentOf(
      actualRiskAmount,
      equity,
    );

    return {
      entry,
      stopLoss,
      stopDistance: NumberUtils.round(stopDistance),
      stopTicks: NumberUtils.round(stopTicks),
      riskPerLot: NumberUtils.round(riskPerLot),
      rawVolume: NumberUtils.round(rawVolume),
      volume: NumberUtils.round(volume),
      actualRiskAmount: NumberUtils.round(actualRiskAmount),
      actualRiskPercent: NumberUtils.round(actualRiskPercent),
      cappedAtMaximum,
      belowMinimum,
    };
  }
}
