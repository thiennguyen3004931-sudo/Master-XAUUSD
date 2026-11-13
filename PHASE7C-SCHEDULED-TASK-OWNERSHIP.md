# Phase7C Scheduled Task Ownership

This hardening layer protects `XAUUSD-Phase7C-Executors` from accidental mutation when Task Scheduler state is ambiguous or belongs to another workload.

## Ownership proof

The task name alone is never treated as ownership. A task is owned only when it has exactly one action and that action is the canonical Windows PowerShell launcher:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File <ProjectRoot>\scripts\run-phase7c-executor-task-runner-local.ps1
```

The runner path must resolve exactly to this repository. Multiple actions, another executable, another runner path, or extra arguments are blocked.

## Canonical definition

After action ownership is proven, the verifier checks:

- one `AtStartup` trigger;
- `AllowDemandStart = True`;
- `StartWhenAvailable = True`;
- `MultipleInstances = IgnoreNew`;
- `RestartCount = 0`;
- `ExecutionTimeLimit = PT0S`;
- principal `RunLevel = Highest`.

`register-phase7c-executor-task-local.ps1 -Repair` only repairs an already-owned task and preserves its existing principal object. It does not delete the task, force-replace an unknown task, or kill runtime processes. Principal RunLevel drift is intentionally not repaired automatically because changing identity/logon semantics requires explicit review.

If the task is absent, creation is opt-in with `-Create` and requires both an explicit `-PrincipalUserId` and an explicit `-PrincipalLogonType` (`Interactive`, `S4U`, or `ServiceAccount`). The script never guesses task identity or logon semantics and does not accept password-based creation modes.

## Provider diagnostics

Task Scheduler failures are classified as `ACCESS_DENIED`, `NOT_FOUND`, or `PROVIDER_ERROR`. `ACCESS_DENIED` and unknown provider failures always block mutation.

## Startup-runner singleton verification

With `verify-phase7c-executors-local.ps1 -RequireMigratedTask`, strict verification now requires all of the following:

- exact owned startup-runner action;
- no canonical task-definition drift;
- Scheduled Task state `Running`;
- `startup-runner-status.json` identifies a live runner PID;
- `.runtime\phase7c-executors\startup-runner.lock` is exclusively held.

The lock probe treats only Windows sharing/lock violations as `HELD`. `ACCESS_DENIED`, missing files, generic I/O errors, and an openable lock file are failures in strict mode.

## Safe operating sequence

Do not use the registration script as a runtime restart mechanism. For a live source cutover, first place the bot in `PAUSE`, prove there are no XAUUSD positions/managed tickets/pending entry, stop the Scheduled Task and confirm the old runner exited, stop repo-owned executor children, then start the task and run strict verifier plus smoke tests. Do not restore `AUTO` until both checks pass.

This hardening does not alter trading strategy, lot sizing, stop-loss/take-profit rules, broker symbol mapping, DEMO-only execution, or the MT5 panel read-only `ORDER_PERMISSION=NONE` safety contract.
