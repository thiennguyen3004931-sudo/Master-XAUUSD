# Phase 6C — BASELINE_BUY Forward Holdout

Phase 6C is a new untouched forward-validation lane selected only after the Phase 6/6A/6B historical diagnostics were complete.

## Immutable candidate

Primary candidate: `BASELINE_BUY` only.

- M15 bullish body engulfing trigger.
- MA trend: MA20 > MA50 > MA200 and M15 close > MA20.
- Minimum confluence score: 2 of 3 (MA pullback, FVG, Volume Profile).
- Canonical M15 entry only.
- No M5 rescue.
- Structural stop: engulfing-candle low.
- Dynamic volume with per-trade risk cap <= USD 10.
- +6 price: stop moves to entry +2.
- +10 price: trailing stop activates with distance 5.
- Trend exit: M15 close below MA20.

The entire baseline config is asserted by `Phase6CForwardHoldoutService`. Any config drift aborts the holdout.

## Cutoff and timebase

Real UTC cutoff (immutable):

`2026-08-12T16:10:00.000Z`

Vietnam local time: 2026-08-12 23:10 +07.

The existing MT5 replay dataset uses the broker +03 server-clock coordinate as epoch-like timestamps. Therefore the same cutoff maps to:

`2026-08-12T19:10:00.000Z`

Dataset offset: 10,800,000 ms.

The local runner verifies the observed broker-host offset and rejects a deviation greater than five minutes after minute normalization.

## Pre-registered decision gate

Until 30 BASELINE_BUY trades are filled after the cutoff:

`PHASE6C_STATUS=INSUFFICIENT_SAMPLE`

At 30 or more filled trades, PASS requires all of:

- Net PnL > 0
- Expectancy > 0
- Average R > 0
- Profit Factor > 1.20

Otherwise Phase 6C returns FAIL.

Do not change the cutoff, candidate, management, confluence threshold, minimum trade count, or PF floor based on Phase 6C forward results.

## Frozen + forward data handling

`scripts/run-phase6c-forward-local.ps1`:

1. exports fresh MT5 M15/M5 data;
2. verifies broker timestamp offset;
3. preserves every frozen Phase 4 bar unchanged;
4. appends bridge bars between the frozen tail and the Phase 6C cutoff;
5. appends forward bars strictly after the Phase 6C cutoff;
6. hashes the merged dataset;
7. rebuilds `@xauusd/risk-engine`;
8. runs the standalone Phase 6 strategy on the merged dataset;
9. filters only post-cutoff BASELINE_BUY trades through `Phase6CForwardHoldoutService`;
10. appends progress to `phase6c-progress.csv`.

## Local commands

Single run:

```powershell
$work = "F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master\apps\api\data\historical-replay\work-20260812-154207"
powershell -ExecutionPolicy Bypass -File ".\scripts\run-phase6c-forward-local.ps1" -WorkDir "$work" -MaxRiskUsd 10
```

Continuous watcher:

```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\watch-phase6c-forward-local.ps1" -WorkDir "$work" -IntervalMinutes 30 -MaxRiskUsd 10
```

Watcher log:

```powershell
Get-Content "$work\phase6c-forward-watch\phase6c-watch.log" -Tail 60 -Wait
```

Latest progress:

```powershell
Import-Csv "$work\phase6c-progress.csv" | Select-Object -Last 1 | Format-List
```

## Scope

Phase 6C remains research-only. It does not place MT5 orders and does not mutate production execution.

`PHASE6C_PRODUCTION_MUTATION=false`
