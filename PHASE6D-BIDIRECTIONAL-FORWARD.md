# Phase 6D — Bidirectional Forward Holdout

Phase 6D replaces the BUY-only research watcher as the preferred bidirectional forward-validation lane. It does not mutate production and does not place MT5 orders.

## Locked candidate

- Candidate: `BASELINE_BUY_SELL`
- BUY: bullish body engulfing + MA20 > MA50 > MA200 + close > MA20
- SELL: bearish body engulfing + MA20 < MA50 < MA200 + close < MA20
- Confluence: at least 2 of MA pullback, FVG, Volume Profile
- Entry: canonical M15 close
- Structural stop: engulfing candle low for BUY, high for SELL
- M5 rescue: disabled
- Risk cap: supplied by runner, expected `$10`
- Break-even: +6 price -> stop +2
- Trailing: activates at +10 with distance 5
- Trend exit: M15 close across MA20 against the trade

## Locked forward cutoff

- Real UTC cutoff: `2026-08-12T16:25:00.000Z`
- Vietnam time: `2026-08-12 23:25 +07`
- Broker dataset +03 coordinate: `2026-08-12T19:25:00.000Z`

The cutoff must not move based on forward outcomes.

## Gate

Until 30 filled BUY+SELL trades exist, status is `INSUFFICIENT_SAMPLE`.

After 30 fills, PASS requires all of:

- net PnL > 0
- expectancy > 0
- average R > 0
- profit factor > 1.20

BUY and SELL are also reported separately for monitoring, but both sides are eligible for the combined forward population.

## Local runner

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-phase6d-forward-local.ps1 -WorkDir "$work" -MaxRiskUsd 10
```

## Watcher

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\watch-phase6d-forward-local.ps1 -WorkDir "$work" -IntervalMinutes 30 -MaxRiskUsd 10
```

Research only. `PHASE6D_PRODUCTION_MUTATION=false`.
