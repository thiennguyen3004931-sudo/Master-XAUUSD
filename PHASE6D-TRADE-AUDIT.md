# Phase 6D Trade Audit

Phase 6D remains the pre-registered bidirectional forward-validation lane for canonical M15 BUY and SELL trades. This audit layer is observability only: it does not change signal generation, risk acceptance, entry, stop loss, management, cutoff, or PASS/FAIL gates.

## Frozen Phase 6D invariants

- candidate: `BASELINE_BUY_SELL`
- real cutoff UTC: `2026-08-12T16:25:00.000Z`
- broker dataset cutoff: `2026-08-12T19:25:00.000Z`
- dataset offset: `+03:00` / `10800000 ms`
- minimum confluence: `2/3`
- entry: canonical M15 close, 15-minute fill window
- M5 rescue: disabled
- per-trade risk cap: `$10`
- break-even: `+6 -> SL +2`
- trailing: starts at `+10`, distance `5`
- minimum filled trades: `30`
- combined PF gate: `> 1.20`
- production mutation: false

## Per-trade audit fields

Every post-cutoff eligible Phase 6D trade is emitted as `PHASE6D_TRADE_AUDIT_N=...` and written to CSV with:

- ID and side
- signal time in broker dataset coordinate and corrected real UTC
- canonical entry and original structural stop loss
- dynamic volume and initial risk USD
- MA20, MA50, MA200, ATR
- confluence score and component flags: MA pullback, FVG, volume profile
- POC / VAH / VAL when the volume profile is available
- fill state and fill time
- whether +6 was reached and break-even applied
- whether +10 was reached and trailing activated
- final stop loss
- exit reason, exit price and exit time
- PnL, R multiple, holding time and outcome

## Files

Each forward run writes:

`phase6d-forward-runs/<timestamp>/phase6d-trade-audit.csv`

The runner also replaces this convenience snapshot after every successful run:

`phase6d-trade-audit-latest.csv`

Because each Phase 6D run replays all post-cutoff eligible trades to date, the latest CSV is a current full audit snapshot rather than a one-run delta.

## Interpretation

`SIGNAL_DATASET` and other dataset timestamps are the broker +03 timestamp coordinate used by the historical replay files. `SIGNAL_REAL_UTC` subtracts the locked `10800000 ms` coordinate offset. The conversion is diagnostic only and does not move the Phase 6D research cutoff.

The audit layer must never be used to retune Phase 6D while the forward sample is accumulating. Any future strategy change requires a new explicitly locked research lane/cutoff.