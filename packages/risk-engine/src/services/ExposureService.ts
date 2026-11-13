import type {
  ExposureProjection,
  RiskContext,
} from "../models";
import { NumberUtils } from "../utils";

export class ExposureService {
  calculate(
    context: RiskContext,
    proposedRiskAmount: number,
  ): ExposureProjection {
    const currentOpenRiskAmount = context.portfolio.openPositions.reduce(
      (sum, item) =>
        sum + (item.currentRiskAmount ?? item.initialRiskAmount),
      0,
    );

    const symbolPositionCount = context.portfolio.openPositions.filter(
      (item) => item.position.symbol === context.instrument.symbol,
    ).length;

    const projectedOpenRiskAmount =
      currentOpenRiskAmount + proposedRiskAmount;

    return {
      openPositionCount: context.portfolio.openPositions.length,
      symbolPositionCount,
      currentOpenRiskAmount: NumberUtils.round(currentOpenRiskAmount),
      projectedOpenRiskAmount: NumberUtils.round(projectedOpenRiskAmount),
      projectedOpenRiskPercent: NumberUtils.round(
        NumberUtils.percentOf(
          projectedOpenRiskAmount,
          context.account.equity,
        ),
      ),
    };
  }
}
