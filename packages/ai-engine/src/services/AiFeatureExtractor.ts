import type { IAiFeatureExtractor } from "../contracts";
import type {
  AiContext,
  AiFeatureVector
} from "../models";
import { NumberUtils } from "../utils";

export class AiFeatureExtractor
  implements IAiFeatureExtractor
{
  extract(context: AiContext): AiFeatureVector {
    const strategy =
      context.strategyEvaluation.selection.selected;
    const plan = context.strategyEvaluation.plan;
    const signal = context.signalResult.signal;
    const risk = context.riskAssessment;
    const indicators = context.indicators.latest;
    const backtest = context.backtestMetrics;
    const recent = context.recentPerformance;

    const riskDistance = plan
      ? Math.abs(
          plan.order.entry - plan.order.stopLoss
        )
      : 0;
    const rewardDistance = plan
      ? Math.abs(
          plan.order.takeProfit - plan.order.entry
        )
      : 0;

    return {
      symbol: context.analysis.symbol,
      timeframe: String(context.analysis.timeframe),
      generatedAt:
        context.evaluatedAt ?? Date.now(),
      strategyAction:
        context.strategyEvaluation.action,
      strategyId:
        strategy?.strategyId ?? null,
      strategyScore:
        strategy?.score ?? 0,
      strategyConfidence:
        strategy?.score ?? 0,
      strategyEdge:
        context.strategyEvaluation.selection.edge,
      regime:
        context.strategyEvaluation.regime.regime,
      regimeConfidence:
        context.strategyEvaluation.regime.confidence,
      signalDecision:
        String(context.signalResult.decision),
      signalConfidence:
        signal?.confidence ??
        context.signalResult.score.confidence,
      signalDirectionalEdge:
        context.signalResult.score.directionalEdge,
      signalAccepted:
        context.signalResult.diagnostics.accepted,
      riskApproved: risk.approved,
      approvedRiskPercent:
        risk.budget?.approvedRiskPercent ?? 0,
      approvedRiskAmount:
        risk.budget?.approvedRiskAmount ?? 0,
      positionSize:
        risk.sizing?.volume ??
        risk.order?.volume ??
        0,
      projectedMarginUsagePercent:
        risk.margin?.projectedMarginUsagePercent ?? 0,
      projectedOpenRiskPercent:
        risk.exposure?.projectedOpenRiskPercent ?? 0,
      analysisScore: context.analysis.score,
      dataQuality:
        context.analysis.metrics.dataQuality,
      volatilityPercent:
        context.analysis.metrics.volatilityPercent,
      trend: String(context.analysis.trend),
      structure: String(context.analysis.structure),
      mtfBias:
        context.multiTimeframe
          ? String(context.multiTimeframe.bias)
          : null,
      mtfConfidence:
        context.multiTimeframe?.confidence ?? 0,
      atr: indicators.atr,
      rsi: indicators.rsi,
      adx: indicators.adx.adx,
      macdHistogram:
        indicators.macd.histogram,
      stochasticK:
        indicators.stochastic.k,
      stochasticD:
        indicators.stochastic.d,
      warmupComplete:
        context.indicators.warmupComplete,
      orderRiskReward:
        riskDistance > 0
          ? NumberUtils.round(
              rewardDistance / riskDistance
            )
          : 0,
      spreadWarningCount:
        context.strategyEvaluation.diagnostics.warnings
          .filter((warning) =>
            warning.toLowerCase().includes("spread")
          ).length,
      rejectionCount:
        context.strategyEvaluation.diagnostics
          .rejectionCodes.length +
        context.riskAssessment.diagnostics
          .rejectionCodes.length +
        context.signalResult.diagnostics
          .rejectionCodes.length,
      backtestTradeCount:
        backtest?.totalTrades ?? 0,
      backtestWinRatePercent:
        backtest?.winRatePercent ?? 0,
      backtestProfitFactor:
        Number.isFinite(backtest?.profitFactor)
          ? backtest?.profitFactor ?? 0
          : 99,
      backtestMaxDrawdownPercent:
        backtest?.maxDrawdownPercent ?? 0,
      recentTradeCount:
        recent?.sampleSize ?? 0,
      recentWinRatePercent:
        recent?.winRatePercent ?? 0,
      recentProfitFactor:
        Number.isFinite(recent?.profitFactor)
          ? recent?.profitFactor ?? 0
          : 99,
      recentAverageRMultiple:
        recent?.averageRMultiple ?? 0,
      recentConsecutiveLosses:
        recent?.consecutiveLosses ?? 0
    };
  }
}
