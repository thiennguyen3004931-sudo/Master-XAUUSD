import type {
  InstrumentRiskSpec,
  MarginProjection,
  RiskContext,
} from "../models";
import { NumberUtils } from "../utils";

export class MarginService {
  calculate(
    context: RiskContext,
    entry: number,
    volume: number,
    instrument: InstrumentRiskSpec,
  ): MarginProjection {
    const notionalValue = entry * instrument.contractSize * volume;
    const requiredMargin =
      context.account.leverage > 0
        ? notionalValue / context.account.leverage
        : Number.POSITIVE_INFINITY;

    const projectedMargin = context.account.margin + requiredMargin;
    const projectedMarginUsagePercent = NumberUtils.percentOf(
      projectedMargin,
      context.account.equity,
    );
    const projectedFreeMargin = context.account.freeMargin - requiredMargin;
    const projectedFreeMarginPercent = NumberUtils.percentOf(
      projectedFreeMargin,
      context.account.equity,
    );

    return {
      notionalValue: NumberUtils.round(notionalValue),
      requiredMargin: NumberUtils.round(requiredMargin),
      projectedMargin: NumberUtils.round(projectedMargin),
      projectedMarginUsagePercent: NumberUtils.round(
        projectedMarginUsagePercent,
      ),
      projectedFreeMargin: NumberUtils.round(projectedFreeMargin),
      projectedFreeMarginPercent: NumberUtils.round(
        projectedFreeMarginPercent,
      ),
    };
  }
}
