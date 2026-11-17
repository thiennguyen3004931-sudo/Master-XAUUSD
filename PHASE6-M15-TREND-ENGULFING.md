# Phase 6 — M15 Trend Engulfing

## Purpose

Phase 6 is a separate research lane designed to increase trade frequency relative to the locked Phase 5 `CANONICAL_SELL` holdout. It must not modify Phase 5 preregistration, production execution, DEMO statistics, or LIVE locks.

## Signal trigger

A closed M15 candle must form a body engulfing pattern.

BUY:
- previous M15 candle bearish;
- current M15 candle bullish;
- current open <= previous close;
- current close >= previous open.

SELL is the exact inverse.

## Trend filter

BUY requires:
- MA20 > MA50 > MA200;
- M15 close > MA20.

SELL requires:
- MA20 < MA50 < MA200;
- M15 close < MA20.

The engulfing candle is the trigger. Moving averages are a trend filter, not the trigger.

## Confluence score

After engulfing + trend pass, Phase 6 scores three independent confirmations:

1. MA pullback: the engulfing candle interacts with MA20 or MA50 using an ATR-scaled tolerance.
2. FVG: the engulfing candle interacts with a same-direction three-candle imbalance found in the recent M15 lookback.
3. Volume profile: the engulfing candle interacts with POC, VAH, or VAL from the recent profile window.

Default requirement: at least 2 of 3 confirmations.

The profile is deterministic and uses available bar volume. If the input bars do not contain usable volume, the implementation falls back to equal bar weights rather than inventing external exchange volume.

## Entry and risk

- planned entry: close of the confirmed M15 engulfing candle;
- fill simulation: M5 must touch the planned entry within 15 minutes;
- BUY structural stop: engulfing candle low;
- SELL structural stop: engulfing candle high;
- dynamic volume is floored to broker volume step;
- if broker minimum volume cannot fit inside the configured per-trade risk cap, the signal is blocked;
- current research risk cap remains `$10` when run with the project default command.

## Trend management

The management reflects the trend-following preference:

- favorable move +6 price units -> move stop to +2;
- favorable move +10 price units -> activate 5-price-unit trailing stop;
- no fixed take-profit is used by Phase 6;
- if M15 closes through MA20 against the trade, the research trade exits at that M15 close;
- stop checks remain conservative and are evaluated before same-bar management improvements.

## Metrics

Phase 6 emits:

- `PHASE6_ENGULFING_TRIGGERS`
- `PHASE6_TREND_ALIGNED`
- `PHASE6_CONFLUENCE_PASSED`
- `PHASE6_RISK_BLOCKED`
- `PHASE6_SIGNALS`
- `PHASE6_BUY_SIGNALS`
- `PHASE6_SELL_SIGNALS`
- `PHASE6_FILLED_TRADES`
- `PHASE6_WIN_RATE`
- `PHASE6_NET_PNL`
- `PHASE6_PROFIT_FACTOR`
- `PHASE6_EXPECTANCY`
- `PHASE6_AVG_R`
- `PHASE6_MAX_REALIZED_DRAWDOWN_USD`
- `PHASE6_AVG_HOLD_HOURS`
- +6/+10, break-even and trailing counters.

`PHASE6_MAX_REALIZED_DRAWDOWN_USD` is based on realized trade exits in the research replay; it is not a tick-level account-equity drawdown measure.

## Local validation

From repository root on `phase4-risk-entry-compression`:

```powershell
git pull
pnpm --filter @xauusd/risk-engine typecheck
pnpm --filter @xauusd/risk-engine test
pnpm --filter @xauusd/risk-engine build
```

Then run the frozen historical backtest:

```powershell
$work = "F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master\apps\api\data\historical-replay\work-20260812-154207"

powershell -ExecutionPolicy Bypass `
  -File .\scripts\run-phase6-backtest-local.ps1 `
  -WorkDir "$work" `
  -MaxRiskUsd 10
```

The runner automatically:
- finds the latest frozen Phase 4 dataset;
- applies the idempotent Phase 6 hook to the local canonical replay runner;
- builds `@xauusd/risk-engine`;
- runs the frozen replay;
- stores the full console log under `phase6-backtests/<timestamp>`;
- prints only `PHASE6_*` result lines to the terminal.

## Research invariant

The output must include:

```text
PHASE6_RESEARCH_ONLY=PASS
PHASE6_PRODUCTION_MUTATION=false
```

Do not send broker orders from Phase 6 until the historical results are reviewed and a separate DEMO execution phase is explicitly approved.
