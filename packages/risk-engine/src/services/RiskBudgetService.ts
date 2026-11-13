import { SignalStrength } from "@xauusd/types";
import type { RiskEngineConfig } from "../config";
import type { RiskContext, RiskBudget } from "../models";
import { NumberUtils } from "../utils";

export class RiskBudgetService {
  calculate(context: RiskContext, config: RiskEngineConfig): RiskBudget {
    const signal = context.signalResult.signal;
    const confidence = signal?.confidence ?? 0;
    const strength = signal?.strength ?? SignalStrength.VERY_WEAK;

    const confidenceFactor = NumberUtils.clamp(
      confidence / config.minimumConfidenceForFullRisk,
      config.confidenceFloorFactor,
      1,
    );

    const strengthFactor = this.getStrengthFactor(strength);

    const drawdownPercent =
      context.portfolio.peakEquity > 0
        ? NumberUtils.clamp(
            ((context.portfolio.peakEquity - context.account.equity) /
              context.portfolio.peakEquity) *
              100,
            0,
            100,
          )
        : 0;

    const drawdownProgress = NumberUtils.clamp(
      drawdownPercent / config.maxDrawdownPercent,
      0,
      1,
    );
    const drawdownFactor = NumberUtils.clamp(
      1 - drawdownProgress * config.maximumDrawdownRiskReduction,
      1 - config.maximumDrawdownRiskReduction,
      1,
    );

    const lossStreakFactor = NumberUtils.clamp(
      1 -
        context.portfolio.consecutiveLosses *
          config.riskReductionPerConsecutiveLoss,
      0.25,
      1,
    );

    const requestedRiskPercent = NumberUtils.clamp(
      config.baseRiskPercent *
        confidenceFactor *
        strengthFactor *
        drawdownFactor *
        lossStreakFactor,
      config.minRiskPercent,
      config.maxRiskPercent,
    );

    const requestedRiskAmount =
      (context.account.equity * requestedRiskPercent) / 100;

    const currentOpenRiskAmount = context.portfolio.openPositions.reduce(
      (sum, item) =>
        sum + (item.currentRiskAmount ?? item.initialRiskAmount),
      0,
    );

    const maximumOpenRiskAmount =
      (context.account.equity * config.maxTotalOpenRiskPercent) / 100;
    const availablePortfolioRiskAmount = Math.max(
      0,
      maximumOpenRiskAmount - currentOpenRiskAmount,
    );

    const approvedRiskAmount = Math.min(
      requestedRiskAmount,
      availablePortfolioRiskAmount,
    );
    const approvedRiskPercent = NumberUtils.percentOf(
      approvedRiskAmount,
      context.account.equity,
    );

    return {
      baseRiskPercent: config.baseRiskPercent,
      confidenceFactor: NumberUtils.round(confidenceFactor),
      strengthFactor: NumberUtils.round(strengthFactor),
      drawdownFactor: NumberUtils.round(drawdownFactor),
      lossStreakFactor: NumberUtils.round(lossStreakFactor),
      availablePortfolioRiskAmount: NumberUtils.round(
        availablePortfolioRiskAmount,
      ),
      requestedRiskPercent: NumberUtils.round(requestedRiskPercent),
      requestedRiskAmount: NumberUtils.round(requestedRiskAmount),
      approvedRiskPercent: NumberUtils.round(approvedRiskPercent),
      approvedRiskAmount: NumberUtils.round(approvedRiskAmount),
    };
  }

  private getStrengthFactor(strength: SignalStrength): number {
    switch (strength) {
      case SignalStrength.VERY_STRONG:
        return 1.1;
      case SignalStrength.STRONG:
        return 1;
      case SignalStrength.NORMAL:
        return 0.85;
      case SignalStrength.WEAK:
        return 0.7;
      case SignalStrength.VERY_WEAK:
      default:
        return 0.55;
    }
  }
}
