# Phase 4C local validation checklist

Run from the repository root on branch `phase4-risk-entry-compression`.

```powershell
git pull
pnpm --filter @xauusd/risk-engine typecheck
pnpm --filter @xauusd/risk-engine test
pnpm --filter @xauusd/risk-engine build
node .\scripts\apply-phase4c-shadow-hook.mjs ".\apps\api\data\historical-replay\work-20260812-154207\canonical_replay.ts"
pnpm exec tsx "$work\canonical_replay.ts" 2>&1 | Tee-Object "$work\phase4c-console.log"
Select-String -Path "$work\phase4c-console.log" -Pattern "PHASE4C_|PHASE4_FINAL_MINLOT_FEASIBLE|PHASE4_MINLOT_RESCUED"
```

Expected invariants:

- risk-engine typecheck passes;
- risk-engine tests pass;
- `PHASE4_FINAL_MINLOT_FEASIBLE` remains the Phase 4 population count;
- `PHASE4C_TOTAL_CASES` should match the number of feasible cases that also carry a valid canonical take-profit;
- `PHASE4C_RESEARCH_ONLY=PASS`;
- `PHASE4C_MINLOT_FIXED=0.01`;
- `PHASE4C_STOP_FIRST=PASS`;
- `PHASE4C_PRODUCTION_MUTATION=false`.

Do not merge management parameters into production based solely on this replay. Phase 4C is intended to identify management variants for later walk-forward validation.
