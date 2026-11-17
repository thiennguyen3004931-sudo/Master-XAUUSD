# Phase 5 Run

## 1. Pull and validate the package

```powershell
git pull
pnpm --filter @xauusd/risk-engine typecheck
pnpm --filter @xauusd/risk-engine test
pnpm --filter @xauusd/risk-engine build
```

## 2. Apply the pre-registered holdout hook

```powershell
$work = "F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master\apps\api\data\historical-replay\work-20260812-154207"

node .\scripts\apply-phase5-forward-holdout-hook.mjs `
  "$work\canonical_replay.ts"
```

Expected:

```text
PHASE5_HOOK_STATUS=PASS
```

## 3. Cutoff coordinate system

The research cutoff remains locked at real UTC:

`2026-08-12T12:45:00.000Z`

The replay dataset uses this broker's +03:00 timestamp space on the cutoff date, so the same instant is represented inside the replay data as:

`2026-08-12T15:45:00.000Z`

The runner validates the observed broker offset before replay. A timebase mismatch is a hard failure and must not be bypassed.

## 4. Forward validation runner

```powershell
$work = "F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master\apps\api\data\historical-replay\work-20260812-154207"

powershell -ExecutionPolicy Bypass `
  -File .\scripts\run-phase5-forward-local.ps1 `
  -WorkDir "$work"
```

The runner:

1. keeps the latest `frozen-*` Phase 4 snapshot authoritative;
2. exports a timestamped raw M15/M5 snapshot from MT5;
3. checks the broker timestamp offset against +03:00;
4. appends fresh bars after the last frozen bar;
5. treats fresh bars at/before dataset-time 15:45 as bridge/warmup only;
6. requires at least one fresh M5 bar after 15:45 dataset time;
7. builds the risk engine;
8. runs the same canonical replay;
9. stores SHA256 hashes and a timestamped console log.

Important diagnostics:

```text
PHASE5_FORWARD_TIMEBASE_STATUS=PASS
PHASE5_MERGE_REAL_CUTOFF_UTC=2026-08-12T12:45:00.000Z
PHASE5_MERGE_DATASET_CUTOFF=2026-08-12T15:45:00.000Z
PHASE5_MERGE_DATASET_OFFSET_MS=10800000
PHASE5_MERGE_BRIDGE_M15_APPENDED=...
PHASE5_MERGE_BRIDGE_M5_APPENDED=...
PHASE5_MERGE_FORWARD_M15_APPENDED=...
PHASE5_MERGE_FORWARD_M5_APPENDED=...
PHASE5_MERGE_FRESHNESS=PASS
```

## 5. Holdout output

The replay should report:

```text
PHASE5_REAL_CUTOFF_UTC=2026-08-12T12:45:00.000Z
PHASE5_DATASET_CUTOFF=2026-08-12T15:45:00.000Z
PHASE5_DATASET_OFFSET_MS=10800000
PHASE5_CANDIDATE=CANONICAL_SELL
...
PHASE5_STATUS=INSUFFICIENT_SAMPLE|PASS|FAIL
PHASE5_PRE_REGISTERED=PASS
PHASE5_PRODUCTION_MUTATION=false
```

Before 30 filled eligible trades, the only valid decision state is `INSUFFICIENT_SAMPLE`. Do not tune the candidate, management, minimum sample, or PF floor from interim forward results.
