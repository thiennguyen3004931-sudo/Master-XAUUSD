import type { RiskContext } from "../models";

export class RiskInputValidator {
  validate(context: RiskContext): void {
    if (!context || !context.account || !context.portfolio || !context.instrument) {
      throw new TypeError(
        "Risk context must include account, portfolio and instrument.",
      );
    }

    const accountValues = [
      context.account.balance,
      context.account.equity,
      context.account.margin,
      context.account.freeMargin,
      context.account.leverage,
    ];
    if (accountValues.some((value) => !Number.isFinite(value))) {
      throw new TypeError("Account metrics must be finite numbers.");
    }

    if (
      context.portfolio.peakEquity <= 0 ||
      !Number.isFinite(context.portfolio.peakEquity)
    ) {
      throw new RangeError("Portfolio peakEquity must be positive.");
    }

    if (
      context.portfolio.consecutiveLosses < 0 ||
      !Number.isInteger(context.portfolio.consecutiveLosses)
    ) {
      throw new RangeError(
        "Portfolio consecutiveLosses must be a non-negative integer.",
      );
    }

    const instrument = context.instrument;
    const positiveInstrumentValues = [
      instrument.tickSize,
      instrument.tickValuePerLot,
      instrument.contractSize,
      instrument.minVolume,
      instrument.maxVolume,
      instrument.volumeStep,
      instrument.maxSpread,
    ];
    if (
      positiveInstrumentValues.some(
        (value) => !Number.isFinite(value) || value <= 0,
      )
    ) {
      throw new RangeError(
        "Instrument risk values must be finite positive numbers.",
      );
    }

    if (instrument.minVolume > instrument.maxVolume) {
      throw new RangeError(
        "Instrument minVolume cannot exceed maxVolume.",
      );
    }

    if (
      context.signalResult.signal &&
      context.signalResult.signal.symbol !== instrument.symbol
    ) {
      throw new Error(
        "Signal symbol and instrument symbol must match.",
      );
    }
  }
}
