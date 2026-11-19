# Phase 6B — Rescue Outcome and Side Stability

## Purpose

Phase 6B is a research-only diagnostic extension of the immutable Phase 6 baseline and Phase 6A feasibility analysis.

It answers four questions without retuning any strategy parameter:

1. Do the Phase 6A M5-rescued entries actually make or lose money when replayed?
2. Is the strong Phase 6 BUY contribution stable across the same four time folds?
3. Is the marginal Phase 6 SELL contribution stable across those folds?
4. Does baseline + rescued execution improve or degrade net PnL, PF, expectancy, average R, and realized drawdown?

## Immutable inputs

Phase 6B preserves:

- M15 bullish/bearish body engulfing trigger.
- MA20/MA50/MA200 trend alignment.
- minimum confluence score = 2 of 3.
- structural stop at the M15 engulfing low/high.
- maximum per-trade risk = USD 10 unless explicitly changed only as a research runner input.
- break-even trigger = +6 price units.
- break-even offset = +2 price units.
- trailing trigger = +10 price units.
- trailing distance = 5 price units.
- frozen Phase 4/6 M15 and M5 dataset.

No Phase 6A result is used to retune those values.

## Rescue replay

Only Phase 6A cases already proven feasible at the broker minimum volume are replayed.

The rescue entry level must have been known at the M15 signal close. Phase 6A currently allows these sources:

- M5 MA20
- M5 MA50
- pre-existing M5 FVG
- M15 POC
- M15 VAH
- M15 VAL

The entry must be an improved retracement between the canonical M15 close and the unchanged structural stop, and it must be touched during the existing Phase 6 entry window.

At replay time Phase 6B sizes volume down to the configured risk cap using the same broker minimum/step constraints. A better rescue entry may therefore support more than 0.01 lot while remaining at or below the same USD risk cap.

## Outcome ordering

Phase 6B follows the Phase 6 conservative OHLC convention:

1. Existing stop is checked before same-bar management updates.
2. M15 MA20 trend invalidation is honored using only completed M15 bars.
3. +6 applies the +2 positive stop.
4. +10 activates the 5-price-unit trailing stop.

## Side stability

BUY and SELL are evaluated separately across the same four chronological boundaries derived from the Phase 6 baseline population. This prevents each side from receiving a different time partition.

A fold is diagnostic-positive only when it has at least one filled trade and all of the following are positive:

- net PnL
- expectancy
- average R
- profit factor > 1

This is not a promotion gate and does not authorize production execution.

## Combined population

The combined diagnostic population is:

- all Phase 6 baseline cases, plus
- Phase 6A rescued cases replayed in Phase 6B.

The combined output reports aggregate and side-level metrics plus the same side-by-fold stability view.

## Safety invariants

Expected output includes:

- `PHASE6B_RESCUE_STRUCTURAL_STOP_PRESERVED=PASS`
- `PHASE6B_PER_TRADE_RISK_CAP_PRESERVED=PASS`
- `PHASE6B_MANAGEMENT_UNCHANGED=PASS`
- `PHASE6B_NO_RETUNE=PASS`
- `PHASE6B_RESEARCH_ONLY=PASS`
- `PHASE6B_PRODUCTION_MUTATION=false`

Phase 6B does not place orders on MT5 and does not alter live or demo execution.

## Local run

```powershell
$work = "F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master\apps\api\data\historical-replay\work-20260812-154207"

powershell -ExecutionPolicy Bypass -File ".\scripts\run-phase6b-rescue-outcome-local.ps1" -WorkDir "$work" -MaxRiskUsd 10
```

The result is emitted between `PHASE6B_RESULT_BEGIN` and `PHASE6B_RESULT_END` and the full console log is retained under `phase6b-rescue-outcome/<timestamp>/`.
