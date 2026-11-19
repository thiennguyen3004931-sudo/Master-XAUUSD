# Phase 4E local run

```powershell
git pull
pnpm --filter @xauusd/risk-engine typecheck
pnpm --filter @xauusd/risk-engine test
pnpm --filter @xauusd/risk-engine build
node .\scripts\apply-phase4e-walk-forward-hook.mjs ".\apps\api\data\historical-replay\work-20260812-154207\canonical_replay.ts"
pnpm exec tsx "$work\canonical_replay.ts" 2>&1 | Tee-Object "$work\phase4e-console.log"
Select-String -Path "$work\phase4e-console.log" -Pattern "PHASE4E_|PHASE4D_BEST_EXPECTANCY|PHASE4D_BEST_PROFIT_FACTOR|PHASE4D_BEST_NET_PNL"
```

Expected research invariants:

- `PHASE4E_RESEARCH_ONLY=PASS`
- `PHASE4E_PRODUCTION_MUTATION=false`
- 5 chronological folds
- 18 management configs around the Phase 4D +6 / wide-trailing region
