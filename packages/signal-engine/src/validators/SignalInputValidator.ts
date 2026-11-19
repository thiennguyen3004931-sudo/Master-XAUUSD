import type { SignalContext } from "../models";

export class SignalInputValidator {
  validate(context: SignalContext): void {
    if (!context.analysis || !context.indicators) {
      throw new TypeError("analysis and indicators are required");
    }

    const analysisSymbol = context.analysis.symbol.trim().toUpperCase();
    const indicatorSymbol = context.indicators.symbol.trim().toUpperCase();
    if (!analysisSymbol || analysisSymbol !== indicatorSymbol) {
      throw new RangeError("analysis and indicator symbols must match");
    }

    if (String(context.analysis.timeframe) !== String(context.indicators.timeframe)) {
      throw new RangeError("analysis and indicator timeframes must match");
    }

    const candle = context.analysis.lastCandle;
    if (!candle) {
      throw new RangeError("analysis must contain a last candle");
    }

    for (const [name, value] of Object.entries({
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      indicatorClose: context.indicators.latest.close,
    })) {
      if (!Number.isFinite(value)) {
        throw new RangeError(`${name} must be finite`);
      }
    }

    if (Math.abs(candle.close - context.indicators.latest.close) > Math.max(1e-8, candle.close * 1e-8)) {
      throw new RangeError("analysis and indicator snapshots must reference the same closing price");
    }
  }
}
