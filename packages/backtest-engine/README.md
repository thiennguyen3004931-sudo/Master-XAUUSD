# @xauusd/backtest-engine

Event-driven historical replay and performance analytics for XAUUSD AI MASTER.

## What Pack 10 does

- Replays candles in chronological order
- Exposes only candles available at the current historical bar
- Fills plans on the next bar or when the planned entry is touched
- Simulates bid/ask spread, slippage and commission
- Supports BUY and SELL
- Supports Stop Loss, hard invalidation and time stop
- Supports TP1/TP2/TP3 partial exits
- Supports break-even and ATR trailing stop
- Handles ambiguous candles with configurable intrabar policy
- Produces equity, drawdown and monthly-return curves
- Calculates trading performance metrics
- Runs deterministic Monte Carlo resampling
- Creates rolling or anchored walk-forward windows

## Look-ahead protection

`IHistoricalStrategyEvaluator` receives:

```ts
context.candles
```

This array ends at `context.currentIndex`. Future bars are never passed to the evaluator.

A plan generated at the close of candle `N` cannot fill before candle `N + 1`.

## Basic use

```ts
import {
  BacktestEngine,
  FixedCommissionPerLotModel,
  FixedTickSlippageModel,
} from "@xauusd/backtest-engine";

const engine = new BacktestEngine({
  commissionModel: new FixedCommissionPerLotModel(3.5),
  slippageModel: new FixedTickSlippageModel(2),
});

const result = await engine.run({
  candles,
  strategyEvaluator,
  config: {
    initialBalance: 10_000,
    contractSize: 100,
    tickSize: 0.01,
    fallbackSpread: 0.15,
    warmupBars: 250,
    intrabarPriority: "STOP_FIRST",
  },
});
```

## Intrabar ambiguity

OHLC candles do not reveal the exact tick path. When a candle touches both Stop Loss and Take Profit, choose one policy:

- `STOP_FIRST`: conservative
- `TARGET_FIRST`: optimistic sensitivity test
- `OHLC_PATH`: heuristic path based on candle direction

Production evaluation should compare at least `STOP_FIRST` and `OHLC_PATH`.

## XAUUSD contract size

`contractSize: 100` is common for one standard gold lot, but broker specifications vary. Use the exact contract size, tick size, spread and commission from the intended broker.

## Reports

```ts
const formatter = new BacktestReportFormatter();

const markdown = formatter.toMarkdown(result);
const csv = formatter.tradesToCsv(result.trades);
const json = formatter.toJson(result);
```

## Monte Carlo

```ts
const monteCarlo = new MonteCarloService().run(
  result.trades,
  result.metrics.initialBalance,
  {
    iterations: 10_000,
    seed: 42,
    confidenceLevel: 0.95,
  },
);
```

## Build

```bash
pnpm --filter @xauusd/backtest-engine typecheck
pnpm --filter @xauusd/backtest-engine build
pnpm --filter @xauusd/backtest-engine test
```

## Important limitation

Backtests are estimates, not guarantees. Results are highly sensitive to data quality, spread, commission, slippage, execution delay, intrabar assumptions and parameter selection.
