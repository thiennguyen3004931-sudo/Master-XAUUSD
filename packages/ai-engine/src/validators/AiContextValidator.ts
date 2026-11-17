import type { AiContext } from "../models";

export class AiContextValidator {
  validate(context: AiContext): void {
    if (
      !context.analysis ||
      !context.indicators ||
      !context.signalResult ||
      !context.riskAssessment ||
      !context.strategyEvaluation
    ) {
      throw new TypeError(
        "AI context requires analysis, indicators, signal, risk and strategy results."
      );
    }

    const symbols = [
      context.analysis.symbol,
      context.indicators.symbol,
      context.signalResult.signal?.symbol,
      context.riskAssessment.order?.symbol,
      context.strategyEvaluation.plan?.order.symbol
    ].filter(
      (symbol): symbol is string =>
        typeof symbol === "string"
    );

    if (
      symbols.length > 1 &&
      new Set(symbols).size !== 1
    ) {
      throw new Error(
        "All AI context components must use the same symbol."
      );
    }
  }
}
