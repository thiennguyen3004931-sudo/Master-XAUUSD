import type {
  BacktestResult,
  BacktestTrade,
} from "../models";

export class BacktestReportFormatter {
  toMarkdown(result: BacktestResult): string {
    const metrics = result.metrics;
    return [
      `# Backtest Report — ${result.symbol} ${result.timeframe}`,
      "",
      `- Run ID: ${result.runId}`,
      `- Status: ${result.status}`,
      `- Initial balance: ${metrics.initialBalance.toFixed(2)}`,
      `- Final balance: ${metrics.finalBalance.toFixed(2)}`,
      `- Net profit: ${metrics.netProfit.toFixed(2)}`,
      `- Net return: ${metrics.netReturnPercent.toFixed(2)}%`,
      `- Total trades: ${metrics.totalTrades}`,
      `- Win rate: ${metrics.winRatePercent.toFixed(2)}%`,
      `- Profit factor: ${this.formatNumber(metrics.profitFactor)}`,
      `- Max drawdown: ${metrics.maxDrawdownAmount.toFixed(2)} (${metrics.maxDrawdownPercent.toFixed(2)}%)`,
      `- Sharpe ratio: ${metrics.sharpeRatio.toFixed(2)}`,
      `- Sortino ratio: ${metrics.sortinoRatio.toFixed(2)}`,
      `- Average R: ${metrics.averageRMultiple.toFixed(2)}`,
      "",
      "## Diagnostics",
      "",
      `- Candles processed: ${result.diagnostics.candlesProcessed}`,
      `- Strategy evaluations: ${result.diagnostics.strategyEvaluations}`,
      `- Executable plans: ${result.diagnostics.executablePlans}`,
      `- Entries filled: ${result.diagnostics.entriesFilled}`,
      `- Pending orders expired: ${result.diagnostics.pendingOrdersExpired}`,
    ].join("\n");
  }

  tradesToCsv(trades: readonly BacktestTrade[]): string {
    const header = [
      "id",
      "symbol",
      "side",
      "strategyId",
      "entryTime",
      "exitTime",
      "entryPrice",
      "averageExitPrice",
      "initialVolume",
      "grossPnl",
      "commission",
      "netPnl",
      "rMultiple",
      "durationMinutes",
      "exitReason",
    ].join(",");

    return [
      header,
      ...trades.map((trade) =>
        [
          trade.id,
          trade.symbol,
          trade.side,
          trade.strategyId,
          trade.entryTime,
          trade.exitTime,
          trade.entryPrice,
          trade.averageExitPrice,
          trade.initialVolume,
          trade.grossPnl,
          trade.commission,
          trade.netPnl,
          trade.rMultiple,
          trade.durationMinutes,
          trade.exitReason,
        ]
          .map((value) => this.escapeCsv(String(value)))
          .join(","),
      ),
    ].join("\n");
  }

  toJson(result: BacktestResult): string {
    return JSON.stringify(result, null, 2);
  }

  private escapeCsv(value: string): string {
    return /[",\n]/.test(value)
      ? `"${value.replaceAll('"', '""')}"`
      : value;
  }

  private formatNumber(value: number): string {
    return Number.isFinite(value)
      ? value.toFixed(2)
      : "Infinity";
  }
}
