# Phase 7A – Trend Rider Diagnostics

Phase 7A is diagnostic-only. It replays the locked Phase 7 research configuration and measures where performance comes from without changing entry, stop, management, side selection, or production behavior.

## Locked Phase 7 input

- M15 body engulfing mandatory for BUY and SELL.
- MA trend alignment mandatory.
- Same-direction FVG mandatory.
- Fixed research volume defaults to 0.03 lot.
- Risk-cap sizing is off.
- Stop distance is clamped to 6–10 XAUUSD price units.
- At +6: close one-third when broker volume step permits and protect the remainder at +2.
- At +10: close another one-third when permitted and activate a 5-price trailing stop.
- Remaining position follows the trend until stop/trailing or M15 MA20 trend exit.

## Diagnostics

Phase 7A reports:

- BUY vs SELL metrics.
- Stop buckets: `FLOOR_6`, `STRUCT_6_TO_8`, `STRUCT_8_TO_10`, `CAP_10`.
- Management stages: `PRE_PLUS6`, `PLUS6_ONLY`, `PLUS10_TRAIL`.
- Exit reason groups.
- MFE/MAE in R.
- MA20/MA50 and MA50/MA200 percentage separation.
- Most recent matching FVG age and width.
- Real UTC hour buckets.
- Partial-close counterfactual: actual PnL versus holding the full original volume to the same final exit on the same stop/trailing path.

The counterfactual does not change the path or exit. It only measures the PnL effect of scaling out.

## Research guard

Phase 7A must not be used to mutate the current Phase 7 rules automatically. Any hypothesis discovered here must be preregistered and validated on a separate untouched period or a new forward lane.

Expected guards:

```text
PHASE7A_MODE=DIAGNOSTIC_ONLY
PHASE7A_STRATEGY_MUTATION=false
PHASE7A_NO_RETUNE=PASS
PHASE7A_RESEARCH_ONLY=PASS
PHASE7A_PRODUCTION_MUTATION=false
```

## Local run

```powershell
$work = "F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master\apps\api\data\historical-replay\work-20260812-154207"

powershell -ExecutionPolicy Bypass -File ".\scripts\run-phase7a-diagnostics-local.ps1" `
  -WorkDir "$work" `
  -FixedVolume 0.03
```

Latest trade-level diagnostics are copied to:

```text
<WorkDir>\phase7a-trade-diagnostics-latest.csv
```
