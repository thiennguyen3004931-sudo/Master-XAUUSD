# Phase7C Account Runtime System Broker Verifier Plan

**Goal:** Update `verify-phase7c-account-runtime-local.ps1` to verify the current persistent SYSTEM lifecycle broker instead of the removed legacy `startup-runner-status.json` contract.

**Base SHA:** `5b025858b9cfb4f8adb3276420a155dab53b627c`

**Observed runtime evidence:** DEMO recovery successfully completed canonical STOP and START, bridge recovery, zero-position checks, and launched a new healthy executor generation. Strict verification then retried until timeout immediately after process PID/alive checks, before the startup-runner lock marker.

## Root cause

The current verifier still requires `.runtime/phase7c-executors/startup-runner-status.json`, including legacy fields `runnerPid`, `status=SUPERVISOR_RUNNING`, `armed`, `liveExecutionEnabled`, node/pnpm paths, and legacy supervisor ownership checks. The current Scheduled Task runner is instead the persistent SYSTEM lifecycle broker and canonically publishes:

- `.runtime/phase7c-lifecycle-broker/state/heartbeat.json`
- `.runtime/phase7c-lifecycle-broker/state/status.json`
- `brokerPid`
- `state`
- `desiredExecutorState`
- `supervisorPid`
- `accountMode`
- `updatedAt`

It still holds `.runtime/phase7c-executors/startup-runner.lock` and remains directly owned by Windows Task Scheduler.

## TDD workflow

1. RED: add a Windows dual-shell source contract that forbids legacy `startup-runner-status.json`/`SUPERVISOR_RUNNING` and requires lifecycle broker heartbeat/status identity, desired state, freshness, supervisor PID, lock, and Task Scheduler topology.
2. Prove RED fails on the exact stale verifier contract, not on parser/test harness errors.
3. Minimal production fix only in `scripts/verify-phase7c-account-runtime-local.ps1`:
   - remove legacy runner-status dependency;
   - read broker heartbeat/status atomically enough for verification;
   - require version 1, fresh timestamps, matching/live broker PID, matching account mode;
   - require broker state and desired executor state `RUNNING`;
   - require broker status supervisor PID equals the active supervisor PID;
   - preserve singleton lock proof;
   - preserve Windows Task Scheduler parent proof using `brokerPid`;
   - preserve supervisor parent proof using `brokerPid`;
   - leave Telegram, API/Web, Bridge, account/risk, position ownership and read-only safety checks unchanged.
4. GREEN on PowerShell 7 and Windows PowerShell 5.1.
5. Run relevant existing Phase7C lifecycle/account/recovery/API-Web CI.
6. Review exact diff, open PR, merge only after all relevant checks pass with exact head SHA.
7. After merge, rerun bounded DEMO runtime verification. Final required state remains DEMO / PAUSE / zero XAUUSD positions / DISARMED. No LIVE switch, AUTO, ARM, order test, or Bridge write.

## Scope guard

Production scope is exactly one file: `scripts/verify-phase7c-account-runtime-local.ps1`. Do not modify account switch, DEMO recovery, lifecycle broker, executor trading logic, API production code, lot/risk rules, ARM/AUTO, or order paths unless new evidence proves this diagnosis incomplete.
