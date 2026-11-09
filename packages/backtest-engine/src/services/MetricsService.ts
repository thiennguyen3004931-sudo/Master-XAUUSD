import type { BacktestConfig } from "../config";
import type {
  BacktestTrade,
  DrawdownPoint,
  EquityPoint,
  PerformanceMetrics,
} from "../models";
import { NumberUtils } from "../utils";

export class MetricsService {
  calculate(
    trades: readonly BacktestTrade[],
    equityCurve: readonly EquityPoint[],
    drawdownCurve: readonly DrawdownPoint[],
    config: BacktestConfig,
    dataStartTime: number,
    dataEndTime: number,
  ): PerformanceMetrics {
    const finalBalance =
      equityCurve[equityCurve.length - 1]?.balance ??
      config.initialBalance;
    const netProfit = finalBalance - config.initialBalance;
    const winners = trades.filter((trade) => trade.netPnl > 0);
    const losers = trades.filter((trade) => trade.netPnl < 0);
    const breakeven = trades.filter(
      (trade) => Math.abs(trade.netPnl) < 1e-8,
    );
    const grossProfit = winners.reduce(
      (sum, trade) => sum + trade.netPnl,
      0,
    );
    const grossLoss = Math.abs(
      losers.reduce((sum, trade) => sum + trade.netPnl, 0),
    );
    const totalCommission = trades.reduce(
      (sum, trade) => sum + trade.commission,
      0,
    );
    const maxDrawdownAmount = Math.max(
      0,
      ...drawdownCurve.map((point) => point.drawdownAmount),
    );
    const maxDrawdownPercent = Math.max(
      0,
      ...drawdownCurve.map((point) => point.drawdownPercent),
    );

    const dailyReturns = this.dailyReturns(equityCurve);
    const annualRiskFreeDaily =
      config.riskFreeRateAnnual / 100 /
      config.annualTradingDays;
    const excessDaily = dailyReturns.map(
      (value) => value - annualRiskFreeDaily,
    );
    const dailyStd = NumberUtils.standardDeviation(excessDaily);
    const downside = excessDaily.filter((value) => value < 0);
    const downsideStd = NumberUtils.standardDeviation(downside);
    const sharpe =
      dailyStd > 0
        ? (NumberUtils.mean(excessDaily) / dailyStd) *
          Math.sqrt(config.annualTradingDays)
        : 0;
    const sortino =
      downsideStd > 0
        ? (NumberUtils.mean(excessDaily) / downsideStd) *
          Math.sqrt(config.annualTradingDays)
        : 0;

    const years = Math.max(
      (dataEndTime - dataStartTime) /
        (365.25 * 24 * 60 * 60 * 1000),
      0,
    );
    const cagr =
      years > 0 && finalBalance > 0
        ? (Math.pow(
            finalBalance / config.initialBalance,
            1 / years,
          ) -
            1) *
          100
        : 0;

    const totalHoldingMinutes = trades.reduce(
      (sum, trade) => sum + trade.durationMinutes,
      0,
    );
    const totalPeriodMinutes = Math.max(
      (dataEndTime - dataStartTime) / 60_000,
      1,
    );

    const streaks = this.streaks(trades);

    return {
      initialBalance: config.initialBalance,
      finalBalance: NumberUtils.round(finalBalance),
      netProfit: NumberUtils.round(netProfit),
      netReturnPercent: NumberUtils.round(
        (netProfit / config.initialBalance) * 100,
      ),
      grossProfit: NumberUtils.round(grossProfit),
      grossLoss: NumberUtils.round(grossLoss),
      totalCommission: NumberUtils.round(totalCommission),
      totalTrades: trades.length,
      winningTrades: winners.length,
      losingTrades: losers.length,
      breakevenTrades: breakeven.length,
      winRatePercent:
        trades.length > 0
          ? NumberUtils.round(
              (winners.length / trades.length) * 100,
            )
          : 0,
      profitFactor:
        grossLoss > 0
          ? NumberUtils.round(grossProfit / grossLoss)
          : grossProfit > 0
            ? Number.POSITIVE_INFINITY
            : 0,
      expectancy:
        trades.length > 0
          ? NumberUtils.round(netProfit / trades.length)
          : 0,
      averageWin: NumberUtils.round(
        NumberUtils.mean(winners.map((trade) => trade.netPnl)),
      ),
      averageLoss: NumberUtils.round(
        NumberUtils.mean(losers.map((trade) => trade.netPnl)),
      ),
      payoffRatio:
        losers.length > 0 &&
        Math.abs(
          NumberUtils.mean(losers.map((trade) => trade.netPnl)),
        ) > 0
          ? NumberUtils.round(
              NumberUtils.mean(
                winners.map((trade) => trade.netPnl),
              ) /
                Math.abs(
                  NumberUtils.mean(
                    losers.map((trade) => trade.netPnl),
                  ),
                ),
            )
          : 0,
      averageRMultiple: NumberUtils.round(
        NumberUtils.mean(
          trades.map((trade) => trade.rMultiple),
        ),
      ),
      medianRMultiple: NumberUtils.round(
        NumberUtils.median(
          trades.map((trade) => trade.rMultiple),
        ),
      ),
      maxDrawdownAmount: NumberUtils.round(maxDrawdownAmount),
      maxDrawdownPercent: NumberUtils.round(maxDrawdownPercent),
      maxConsecutiveWins: streaks.wins,
      maxConsecutiveLosses: streaks.losses,
      averageHoldingMinutes: NumberUtils.round(
        trades.length > 0
          ? totalHoldingMinutes / trades.length
          : 0,
      ),
      exposurePercent: NumberUtils.round(
        Math.min(
          100,
          (totalHoldingMinutes / totalPeriodMinutes) * 100,
        ),
      ),
      sharpeRatio: NumberUtils.round(sharpe),
      sortinoRatio: NumberUtils.round(sortino),
      cagrPercent: NumberUtils.round(cagr),
      calmarRatio:
        maxDrawdownPercent > 0
          ? NumberUtils.round(cagr / maxDrawdownPercent)
          : 0,
    };
  }

  private dailyReturns(
    equityCurve: readonly EquityPoint[],
  ): number[] {
    const closes = new Map<string, number>();

    for (const point of equityCurve) {
      const date = new Date(point.timestamp);
      const key = date.toISOString().slice(0, 10);
      closes.set(key, point.equity);
    }

    const values = [...closes.values()];
    const returns: number[] = [];
    for (let index = 1; index < values.length; index += 1) {
      const previous = values[index - 1]!;
      const current = values[index]!;
      if (previous > 0) {
        returns.push((current - previous) / previous);
      }
    }
    return returns;
  }

  private streaks(
    trades: readonly BacktestTrade[],
  ): { wins: number; losses: number } {
    let currentWins = 0;
    let currentLosses = 0;
    let maxWins = 0;
    let maxLosses = 0;

    for (const trade of trades) {
      if (trade.netPnl > 0) {
        currentWins += 1;
        currentLosses = 0;
      } else if (trade.netPnl < 0) {
        currentLosses += 1;
        currentWins = 0;
      } else {
        currentWins = 0;
        currentLosses = 0;
      }
      maxWins = Math.max(maxWins, currentWins);
      maxLosses = Math.max(maxLosses, currentLosses);
    }

    return { wins: maxWins, losses: maxLosses };
  }
}
