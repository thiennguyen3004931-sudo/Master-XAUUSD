# Phase7C Broker Desired Executor State Persistence Implementation Plan

> Scope: private source fix only. Production rollout is not authorized.

## Goal

Persist the lifecycle broker's operator-desired executor state across broker/Scheduled Task cold-starts without changing trading, risk, order, ARM, or AUTO logic.

## Safety invariants

- Production remains unchanged.
- Bot mode remains PAUSE during this source-only work.
- LIVE execution remains unarmed.
- Broker cold-start invokes PAUSE before loading durable executor intent, and recovery must positively confirm PAUSE before adopting or launching any supervisor.
- Only durable `RUNNING` may restore executor supervision.
- Missing, corrupt, unsupported-version, or unknown desired-state data fails closed to `STOPPED`.
- Failed/rejected lifecycle requests must not persist a false successful intent.
- If a broker cold-start loses its in-memory supervisor PID while the previous canonical supervisor still lives, recovery may adopt it only after proving the PID is live and its Windows process command line points to the canonical `run-phase7c-executors-local.ps1` path.
- A proven surviving canonical supervisor is adopted rather than launching a duplicate supervisor.
- No production deploy, task repair, Scheduled Task hash update, ARM, AUTO, or live test order in this change.

## Files

- Add: `scripts/test-phase7c-broker-desired-state-persistence-source.ps1`
- Add: `.github/workflows/phase7c-broker-desired-state-persistence-tdd.yml`
- Modify: `scripts/run-phase7c-executor-task-runner-local.ps1`
- Add/update: this implementation plan.

No trading-strategy files are in scope.

## Task 1 — TDD RED: durable-state source contract

Create `scripts/test-phase7c-broker-desired-state-persistence-source.ps1` so the pre-fix source fails for the missing behavior. Assertions require:

1. A dedicated durable desired-state path under the lifecycle broker state directory.
2. Atomic durable persistence using the existing JSON atomic writer.
3. Closed state values: only `RUNNING` and `STOPPED` are accepted.
4. Missing/corrupt/unknown/unsupported durable state resolves to `STOPPED`.
5. Cold-start ordering invokes `Ensure-Phase7CBotPause` before durable intent is loaded.
6. Successful/NOOP START persists `RUNNING` before reporting the request successful/NOOP.
7. Successful/NOOP STOP persists `STOPPED` before reporting the request successful/NOOP.
8. Successful RESTART persists `RUNNING` before reporting success.
9. Rejected/failed START/RESTART paths do not persist `RUNNING`.
10. The existing recovery loop remains the executor restoration mechanism; no new launch subsystem is introduced.
11. Cold-start recovery can adopt a surviving supervisor only from live `supervisor.pid` evidence whose Windows process command line proves the canonical supervisor script path.
12. Recovery must positively confirm PAUSE before survivor adoption or any new supervisor launch.

Capture expected RED failures before each production-source behavior is introduced.

## Task 2 — Minimal implementation

In `scripts/run-phase7c-executor-task-runner-local.ps1`:

1. Add a durable desired-state file under `phase7c-lifecycle-broker/state`.
2. Add one validated reader that returns only `RUNNING` or `STOPPED`, failing closed to `STOPPED` for missing/corrupt/invalid data.
3. Add one validated atomic writer for `RUNNING`/`STOPPED`.
4. On successful/idempotent STOP, atomically persist `STOPPED`, then update in-memory state and complete the request.
5. On successful/idempotent START, atomically persist `RUNNING`, then update in-memory state and complete the request.
6. On successful RESTART, atomically persist `RUNNING`, then update in-memory state and complete the request.
7. Do not persist success intent from rejected/failed actions.
8. Cold-start sequence invokes PAUSE first, then reads durable desired state and assigns the validated result to in-memory `desiredExecutorState`.
9. In `Recover-SupervisorIfNeeded`, positively confirm PAUSE before restoration.
10. If a surviving canonical supervisor is proven by PID plus command-line path, adopt that PID and return `NOOP_ALREADY_RUNNING` without launching a second supervisor.
11. If no canonical survivor is proven, retain the existing delayed recovery and START safety gate before a new supervisor launch.

## Task 3 — Targeted GREEN and regressions

The dedicated TDD workflow runs the desired-state source contract on the repository self-hosted Windows runner at the exact commit SHA. It must prove:

- exact-head checkout identity;
- PowerShell parse validity of the broker runner;
- durable desired-state reader/writer behavior;
- fail-closed behavior;
- successful-request persistence ordering;
- survivor adoption evidence boundary;
- PAUSE-before-adoption/relaunch ordering.

Broader canonical lifecycle, build, security/provenance, and regression coverage remains the responsibility of `Private Master Core Self-Hosted CI` and the existing PR checks.

## Task 4 — Private/self-hosted CI and review

Run the existing private `Private Master Core Self-Hosted CI` at the exact final branch head. This workflow is test/build-only and must retain `M7_PRODUCTION_CUTOVER=NOT_PERFORMED`.

Review `main...fix/phase7c-broker-desired-state-persistence` and confirm only the plan, dedicated TDD workflow/test, and lifecycle broker runner changed. Confirm no trading/risk/order/ARM/AUTO source is modified.

## Task 5 — PR and merge gate

Use the private PR to `main`. Require the dedicated targeted GREEN, relevant lifecycle acceptance evidence, private self-hosted CI, and final diff review to be green/clean before merge.

After merge, stop. Do not deploy production. The runner file hash changes, so a later production rollout requires a separately authorized canonical task/recovery/hash gate with PAUSE + DISARMED + FLAT.