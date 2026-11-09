# Phase 4D local run

```powershell
git pull
pnpm --filter @xauusd/risk-engine typecheck
pnpm --filter @xauusd/risk-engine test
pnpm --filter @xauusd/risk-engine build
node .\scripts\apply-phase4d-sweep-hook.mjs ".\apps\api\data\historical-replay\work-20260812-154207\canonical_replay.ts"
pnpm exec tsx "$work\canonical_replay.ts" 2>&1 | Tee-Object "$work\phase4d-console.log"
Select-String -Path "$work\phase4d-console.log" -Pattern "PHASE4D_|PHASE4C_NET_PNL|PHASE4C_PROFIT_FACTOR|PHASE4C_EXPECTANCY|PHASE4C_AVG_R"
```
