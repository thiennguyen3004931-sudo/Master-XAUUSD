import type { StrategyContext } from "../models";

export class StrategyInputValidator {
  validate(context: StrategyContext): void {
    if (!context.analysis || !context.indicators || !context.signalResult || !context.riskAssessment) {
      throw new TypeError("Strategy context requires analysis, indicators, signal and risk results.");
    }
    const symbols = [
      context.analysis.symbol,
      context.indicators.symbol,
      context.signalResult.signal?.symbol,
      context.riskAssessment.order?.symbol,
    ].filter((value): value is string => typeof value === "string");
    if (new Set(symbols).size > 1) {
      throw new Error("All strategy context components must reference the same symbol.");
    }
    if (!context.indicators.warmupComplete) {
      throw new Error("Indicator warm-up must be complete before strategy selection.");
    }
    if (context.analysis.lastCandle === null) {
      throw new Error("Analysis must include a last candle.");
    }
    if (context.signalResult.signal && context.riskAssessment.order) {
      const signal = context.signalResult.signal;
      const order = context.riskAssessment.order;
      if (signal.entry !== order.entry || signal.stopLoss !== order.stopLoss || signal.takeProfit !== order.takeProfit) {
        throw new Error("Risk-approved order levels must match the accepted signal levels.");
      }
    }
  }
}
