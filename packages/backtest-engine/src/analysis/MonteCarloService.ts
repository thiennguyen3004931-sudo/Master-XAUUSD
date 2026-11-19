import type {
  BacktestTrade,
  MonteCarloConfig,
  MonteCarloPathSummary,
  MonteCarloResult,
} from "../models";
import {
  NumberUtils,
  SeededRandom,
} from "../utils";

export class MonteCarloService {
  run(
    trades: readonly BacktestTrade[],
    initialBalance: number,
    config: MonteCarloConfig,
  ): MonteCarloResult {
    if (
      config.iterations <= 0 ||
      !Number.isInteger(config.iterations)
    ) {
      throw new RangeError(
        "Monte Carlo iterations must be a positive integer.",
      );
    }
    if (
      config.confidenceLevel <= 0 ||
      config.confidenceLevel >= 1
    ) {
      throw new RangeError(
        "confidenceLevel must be between 0 and 1.",
      );
    }

    const random = new SeededRandom(config.seed);
    const pnl = trades.map((trade) => trade.netPnl);
    const paths: MonteCarloPathSummary[] = [];

    for (
      let iteration = 0;
      iteration < config.iterations;
      iteration += 1
    ) {
      let balance = initialBalance;
      let peak = initialBalance;
      let maxDrawdownAmount = 0;
      let maxDrawdownPercent = 0;

      for (let index = 0; index < pnl.length; index += 1) {
        const sampled =
          pnl.length > 0
            ? pnl[random.integer(pnl.length)]!
            : 0;
        balance += sampled;
        peak = Math.max(peak, balance);
        const drawdown = Math.max(0, peak - balance);
        maxDrawdownAmount = Math.max(
          maxDrawdownAmount,
          drawdown,
        );
        maxDrawdownPercent = Math.max(
          maxDrawdownPercent,
          peak > 0 ? (drawdown / peak) * 100 : 0,
        );
      }

      paths.push({
        endingBalance: NumberUtils.round(balance),
        netProfit: NumberUtils.round(balance - initialBalance),
        maxDrawdownAmount:
          NumberUtils.round(maxDrawdownAmount),
        maxDrawdownPercent:
          NumberUtils.round(maxDrawdownPercent),
      });
    }

    const endingBalances = paths.map(
      (path) => path.endingBalance,
    );
    const drawdowns = paths.map(
      (path) => path.maxDrawdownPercent,
    );
    const tailProbability =
      (1 - config.confidenceLevel) / 2;

    return {
      iterations: config.iterations,
      confidenceLevel: config.confidenceLevel,
      probabilityOfLossPercent: NumberUtils.round(
        paths.length > 0
          ? (paths.filter(
              (path) => path.endingBalance < initialBalance,
            ).length /
              paths.length) *
              100
          : 0,
      ),
      endingBalanceP05: NumberUtils.round(
        NumberUtils.percentile(
          endingBalances,
          tailProbability,
        ),
      ),
      endingBalanceMedian: NumberUtils.round(
        NumberUtils.percentile(endingBalances, 0.5),
      ),
      endingBalanceP95: NumberUtils.round(
        NumberUtils.percentile(
          endingBalances,
          1 - tailProbability,
        ),
      ),
      maxDrawdownP50: NumberUtils.round(
        NumberUtils.percentile(drawdowns, 0.5),
      ),
      maxDrawdownP95: NumberUtils.round(
        NumberUtils.percentile(
          drawdowns,
          config.confidenceLevel,
        ),
      ),
      paths,
    };
  }
}
