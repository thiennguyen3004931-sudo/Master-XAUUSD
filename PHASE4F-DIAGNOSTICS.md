# Phase 4F — shadow diagnostics and baseline reconciliation

Phase 4E produced positive walk-forward evidence, but the shadow set moved from the prior 163-case baseline to 164 cases. Phase 4F diagnoses this before any Phase 5 promotion.

## Goals

- determine whether 164 cases contain a duplicate research case ID
- reconcile `shadowCases().length` with `PHASE4_FINAL_MINLOT_FEASIBLE`
- decompose the five chronological folds by canonical vs rescued cases, BUY vs SELL, and entry source
- inspect the weak fold using a fixed management configuration rather than optimizing again

## Fixed diagnostic management

- BE trigger: +6
- BE offset: +2
- trailing trigger: +10
- trailing distance: 5

This is the Phase 4E robust-best configuration and is used only to characterize the sample.

## Important invariants

- research only
- no forced deduplication
- no canonical signal mutation
- no canonical structural stop mutation
- no production sizing/execution mutation

## Run

```powershell
git pull
pnpm --filter @xauusd/risk-engine typecheck
pnpm --filter @xauusd/risk-engine test
pnpm --filter @xauusd/risk-engine build

node .\scripts\apply-phase4f-diagnostics-hook.mjs `
  ".\apps\api\data\historical-replay\work-20260812-154207\canonical_replay.ts"

pnpm exec tsx "$work\canonical_replay.ts" 2>&1 |
  Tee-Object "$work\phase4f-console.log"

Select-String -Path "$work\phase4f-console.log" -Pattern "PHASE4F_"
```

## Interpretation

- `PHASE4F_DUPLICATE_CASE_IDS > 0`: investigate duplicate research case IDs before trusting aggregate results.
- `PHASE4F_DUPLICATE_CASE_IDS=0` and `PHASE4F_PHASE4_FINAL_MINLOT_FEASIBLE=164`: the upstream feasible baseline genuinely shifted and must be reconciled against the prior 163-case replay.
- `PHASE4F_SHADOW_DELTA=0`: shadow construction agrees with Phase 4 feasibility counters.
- fold/source lines identify which cohort drives the weak time segment.
