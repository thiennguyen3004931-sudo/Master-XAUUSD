# Phase7C Account Switch Canonical Lifecycle Implementation Plan

> **Execution mode:** Inline TDD in the current session. Preserve RED → GREEN history and merge only after full verification.

**Goal:** Make account switching and failed-switch DEMO recovery control the Phase7C executor generation only through the existing SYSTEM lifecycle broker, while keeping the Scheduled Task broker process alive.

**Architecture:** `XAUUSD-Phase7C-Executors` is infrastructure: its Scheduled Task runs `run-phase7c-executor-task-runner-local.ps1`, which remains alive as the SYSTEM lifecycle broker. Account switch/recovery must never start or stop that task as a way to control executor generations. Instead they verify the task + broker are already healthy, request canonical lifecycle STOP when required, mutate account/bridge configuration only while executor runtime is stopped, then request canonical lifecycle START after the selected bridge/account is healthy.

**Base:** exact `main` SHA `7454fbd04c27e101ac4a25fa67a89b7faa4cd991`.

**Safety constraints:**
- Bot remains PAUSE throughout account switching/recovery.
- No AUTO activation.
- No LIVE ARM mutation beyond existing account-switch/recovery safety behavior.
- No order test or synthetic MT5 order.
- No Bridge API write endpoint.
- Bridge Scheduled Task switching remains in scope because account mode changes require the selected bridge profile; only executor Scheduled Task mutation is forbidden.
- If the SYSTEM broker task is not already Running/READY, fail closed rather than silently booting privileged infrastructure.
- Failed-switch DEMO recovery may encounter account/Bridge mismatch. If executor desired state is already STOPPED, accept that safe state. If it is RUNNING, canonical STOP is allowed only through the lifecycle API; if that cannot pass its safety gate, recovery fails closed rather than stopping the Scheduled Task directly.

---

## Task 1 — RED source contract

**Files**
- Create `scripts/test-phase7c-account-switch-canonical-lifecycle-local.ps1`
- Create `.github/workflows/phase7c-account-switch-canonical-lifecycle-ci.yml`
- Create this plan

**Contract**
1. Both target scripts forbid `Start-ScheduledTask -TaskName $ExecutorTaskName` and `Stop-ScheduledTask -TaskName $ExecutorTaskName`.
2. Both use canonical `/api/v1/phase7c/lifecycle/stop` and `/api/v1/phase7c/lifecycle/start`.
3. Both verify the executor Scheduled Task exists and remains Running, the broker is READY, and `desiredExecutorState` reaches STOPPED/RUNNING as appropriate.
4. Top-level control flow must STOP before account-state mutation and START after account-state mutation.
5. RED must fail on current source for the intended legacy executor-task lifecycle behavior, not test-harness errors.

Commit RED only before any production edits.

---

## Task 2 — Minimal production fix

**Files**
- Modify `scripts/switch-phase7c-account-mode-local.ps1`
- Modify `scripts/recover-phase7c-demo-after-failed-switch-local.ps1`

**Implementation**
1. Add a broker/task readiness helper that:
   - `Get-ScheduledTask` for `$ExecutorTaskName`
   - requires task State `Running`
   - GETs `/api/v1/phase7c/lifecycle`
   - requires `broker.ready=true`
   - exposes canonical `desiredExecutorState` from broker status/heartbeat.
2. Add canonical STOP helper:
   - if already safely STOPPED with no executor runtime alive, treat as NOOP
   - otherwise POST `/api/v1/phase7c/lifecycle/stop`
   - require action STOPPED
   - wait for desired STOPPED and no executor processes
   - require the broker Scheduled Task still Running.
3. Replace executor task stop/start calls in account switch with canonical STOP/START.
4. Replace executor task stop/start calls in DEMO recovery with canonical STOP/START; preserve bridge recovery operations.
5. Preserve rollback fail-closed behavior. A rollback must not mutate bridge/account again unless executor runtime has been confirmed stopped through the broker.
6. Do not change API, Bridge, executor trading logic, ARM/AUTO behavior, or lot/risk rules.

---

## Task 3 — GREEN and full regression

1. Run the new source contract in PowerShell 7 and Windows PowerShell 5.1.
2. Run existing relevant CI including Phase7C Sideway Regime and Web/LIVE-arm source safety where triggered.
3. Review exact diff against base; only the two target production scripts plus test/workflow/plan are allowed.
4. Open PR to `main`, preserve exact RED/GREEN evidence.
5. Merge with merge commit only after all gates are green; lock expected head SHA.
6. Verify fresh `main` exact merge SHA and parentage.

---

## Task 4 — Windows runtime verification after merge

Use DEMO only. Do not switch to LIVE.

1. Require current baseline DEMO / PAUSE / zero XAUUSD positions / DISARMED.
2. Prove `XAUUSD-Phase7C-Executors` Scheduled Task broker PID stays alive across a DEMO recovery cycle.
3. Run DEMO recovery path without direct executor Scheduled Task mutation.
4. During canonical STOP, executor supervisor/trend/sideway PIDs disappear while SYSTEM broker task remains Running.
5. During canonical START, new executor PIDs appear and runtime becomes READY.
6. Final state remains DEMO / PAUSE / zero positions / DISARMED.
7. No order test, AUTO, LIVE ARM, Bridge write, or manual executor task restart.
