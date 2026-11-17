# Phase 6A — Contribution, M5 Rescue, and Walk-Forward Diagnostics

Phase 6A is a research-only diagnostic layer on top of the frozen Phase 6 M15 Trend Engulfing baseline.

## Immutable baseline

Phase 6A does not retune or mutate the Phase 6 strategy. It preserves:

- M15 body engulfing trigger
- MA20/MA50/MA200 trend alignment
- minimum confluence score 2/3
- per-trade risk cap USD 10
- broker minimum volume 0.01
- break-even trigger +6 price
- break-even offset +2 price
- trailing trigger +10 price
- trailing distance 5 price
- M15 MA20 trend exit

The known frozen baseline is expected to remain the reference population. Phase 6A first reconstructs the risk-blocked population and aborts if that count does not reconcile with the baseline result.

## Diagnostics

### BUY / SELL contribution

For each side Phase 6A reports filled trades, win rate, net PnL, profit factor, expectancy, average R, realized drawdown, and average hold time.

### Exact confluence groups

Trades are grouped without changing the filter:

- MA + FVG
- MA + Volume Profile
- FVG + Volume Profile
- MA + FVG + Volume Profile
- OTHER (diagnostic fallback)

### M5 rescue feasibility

Only Phase 6 setups already rejected because broker minimum volume would exceed the unchanged risk cap are evaluated.

Candidate rescue levels must be known at the M15 signal close:

- M5 MA20
- M5 MA50
- previously formed M5 FVG
- M15 Volume Profile POC
- M15 Volume Profile VAH
- M15 Volume Profile VAL

A rescue is counted only when:

1. the candidate improves entry toward the unchanged structural stop,
2. 0.01 lot risk at the candidate is <= the unchanged risk cap,
3. an M5 bar after the M15 signal touches the candidate within the unchanged entry window.

This is feasibility diagnostics only. Rescued trades are not added to Phase 6 PnL and do not change the baseline.

### Walk-forward contribution

The existing Phase 6 trade population is divided into four chronological folds. No parameter selection occurs. Each fold reports the same core metrics and a diagnostic positive/negative classification.

## Run locally

```powershell
$work = "F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master\apps\api\data\historical-replay\work-20260812-154207"

powershell -ExecutionPolicy Bypass -File ".\scripts\run-phase6a-diagnostics-local.ps1" -WorkDir "$work" -MaxRiskUsd 10
```

Expected guards:

```text
PHASE6A_BASELINE_IMMUTABLE=PASS
PHASE6A_RISK_BLOCKED_RECONCILED=PASS
PHASE6A_RESCUE_FEASIBILITY_ONLY=PASS
PHASE6A_NO_LOOKAHEAD_RESCUE=PASS
PHASE6A_NO_RETUNE=PASS
PHASE6A_RESEARCH_ONLY=PASS
PHASE6A_PRODUCTION_MUTATION=false
PHASE6A_STATUS=PASS
```
