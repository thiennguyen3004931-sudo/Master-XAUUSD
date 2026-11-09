# Phase 6E — Historical Blind Holdout

## Purpose

Phase 6E validates the locked Phase 6D bidirectional M15 trend-engulfing strategy on historical XAUUSD data that is strictly earlier than the frozen research dataset. It is an additive research lane and does not replace the live-forward Phase 6D holdout.

## Immutable candidate

`BASELINE_BUY_SELL`

Strategy configuration is identical to Phase 6D:

- M15 body engulfing trigger.
- BUY: MA20 > MA50 > MA200 and close > MA20.
- SELL: MA20 < MA50 < MA200 and close < MA20.
- Confluence minimum 2 of 3: MA pullback, FVG, deterministic Volume Profile.
- Canonical M15 close entry; no M5 rescue.
- Structural SL at engulfing candle low/high.
- Maximum risk: USD 10 per trade with broker min-volume/step constraints.
- +6 price units => stop to +2.
- +10 price units => trailing starts at distance 5.
- MA20 trend exit remains unchanged.

## Blind-window construction

The blind period is selected mechanically before observing Phase 6E outcomes:

1. Read the first M15 open timestamp in the existing frozen dataset (`frozenStart`).
2. Set `blindEnd = frozenStart`.
3. Set `blindStart = blindEnd - 360 days`.
4. Add 30 days of earlier warm-up data only for indicators.
5. Fail dataset preparation if any prepared M15/M5 bar opens at or after `frozenStart`.
6. Signals must satisfy `blindStart <= signalTimestamp < blindEnd`.

The default exporter request is 730 days only to provide enough source history. Changing export depth does not change the fixed 360-day evaluation window.

## Fixed folds

The 360-day blind window is divided into six equal chronological time folds. Fold boundaries are independent of trade count and outcomes.

A fold is `POSITIVE` only when it contains at least one filled trade and all of the following are true:

- net PnL > 0;
- expectancy > 0;
- average R > 0;
- profit factor > 1.0.

BUY and SELL fold results are also reported separately, but side-specific results do not alter the primary combined gate.

## Pre-registered primary gate

After at least 30 filled blind trades, Phase 6E passes only if:

- filled trades >= 30;
- profit factor > 1.20;
- net PnL > 0;
- expectancy > 0;
- average R > 0;
- at least 4 of 6 fixed time folds are positive.

Before 30 filled trades, status is `INSUFFICIENT_SAMPLE`. Once the sample is sufficient, failing any primary criterion produces `FAIL`.

## MFE / MAE diagnostics

Phase 6E records per-trade excursion diagnostics without changing trade simulation or the primary gate:

- MFE in price units and R;
- MAE in price units and R;
- maximum favorable/adverse price;
- distance remaining to the +6 management trigger;
- management flags (+6, +10, break-even, trailing).

Excursions use a conservative completed-M5-bar envelope before the recorded exit timestamp, plus entry/exit prices. The exit bar's full high/low range is not used, avoiding a favorable-path assumption after a stop/trend exit that occurred inside that bar.

MFE/MAE is diagnostic only. It must not be used to retune Phase 6E after results are observed.

## Invariants

- No overlap with the frozen Phase 4–6 research dataset.
- No M5 rescue.
- No strategy retuning.
- Risk cap remains USD 10.
- BUY and SELL are both eligible under the same locked rules.
- Phase 6D forward holdout remains separate and should continue independently.
- Research only; `PRODUCTION_MUTATION=false`.

## Local run

```powershell
$work = "F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master\apps\api\data\historical-replay\work-20260812-154207"

powershell -ExecutionPolicy Bypass -File ".\scripts\run-phase6e-historical-blind-local.ps1" `
  -WorkDir "$work" `
  -MaxRiskUsd 10
```

The runner writes a timestamped run directory under `phase6e-historical-runs`, plus the convenience audit file:

`phase6e-historical-trade-audit-latest.csv`

Phase 6E is a historical independent check, not authorization for DEMO/LIVE execution by itself.
