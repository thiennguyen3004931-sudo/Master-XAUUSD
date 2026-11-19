# Phase7B Web Job Object Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure forced termination of the `XAUUSD-Phase7B-Web` supervisor cannot leave API/Web descendant processes or listeners orphaned.

**Architecture:** Add a Windows Job Object helper configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The Phase7B Web supervisor creates the job and assigns itself to it before spawning API/Web children so all descendants inherit containment; existing `finally` cleanup remains for normal shutdown, while kernel-level job cleanup covers forced supervisor termination. The native Job Object handle remains open for the supervisor lifetime so `KILL_ON_JOB_CLOSE` is triggered by supervisor process exit rather than by an explicit close while the supervisor is still running.

**Tech Stack:** Windows PowerShell 5.1, PowerShell 7, Win32 Job Objects via `Add-Type`/PInvoke, GitHub Actions Windows runners.

**Spec:** Approved conversation design: Job Object containment for `run-phase7b-web-autostart.ps1`, fail-closed startup, no Bridge/executor/ARM/AUTO/order mutation.

## Global Constraints

- Start from exact base SHA `49fdbeb8182a21261065e9a662c6f52f62469978`.
- Follow strict TDD: RED behavioral contract first, prove the failure, then production code.
- Do not restart or mutate Bridge or Phase7C executors.
- Do not enable or mutate ARM/AUTO.
- Do not submit MT5 orders or synthetic order tests.
- Keep existing normal-shutdown `finally` child cleanup.
- Job Object setup or assignment failure must fail closed before API/Web children are started.
- Keep the native Job Object handle open for the supervisor lifetime; do not close the last handle while the supervisor is alive.
- A dot-sourced Job Object helper must not mutate the caller's `$ErrorActionPreference` or StrictMode.
- Support Windows PowerShell 5.1 and PowerShell 7.

---

### Task 1: RED forced-supervisor cleanup contract

**Files:**
- Create: `scripts/test-phase7b-web-job-object-cleanup-local.ps1`
- Create: `.github/workflows/phase7b-web-job-object-cleanup-ci.yml`

**Interfaces:**
- Consumes: current `scripts/run-phase7b-web-autostart.ps1` process-start behavior.
- Produces: behavioral contract requiring child and grandchild termination after forced supervisor kill, plus source ordering contract requiring containment before child start.

- [ ] **Step 1: Write the failing behavioral test**

Create a temporary supervisor → child → grandchild PowerShell process chain. The fixture uses the production Job Object helper when present; otherwise it reproduces current uncontained behavior. Force-kill only the supervisor and require both descendants to exit.

- [ ] **Step 2: Add Windows dual-shell CI**

Run:

```powershell
.\scripts\test-phase7b-web-job-object-cleanup-local.ps1
```

under both `pwsh` and Windows PowerShell 5.1.

- [ ] **Step 3: Verify RED**

Expected current-source failure includes:

```text
PHASE7B_WEB_JOB_OBJECT_CLEANUP_TEST=FAIL
VIOLATION=DESCENDANTS_SURVIVED_AFTER_FORCED_SUPERVISOR_TERMINATION ...
VIOLATION=AUTOSTART_JOB_OBJECT_HELPER_REFERENCE_MISSING
```

- [ ] **Step 4: Commit RED only**

Commit message:

```text
test(phase7b): reproduce forced web supervisor orphan cleanup
```

---

### Task 2: Minimal Job Object containment

**Files:**
- Create: `scripts/lib/phase7b-windows-job-object.ps1`
- Modify: `scripts/run-phase7b-web-autostart.ps1`
- Test: `scripts/test-phase7b-web-job-object-cleanup-local.ps1`

**Interfaces:**
- Produces: `New-Phase7BKillOnCloseJob -Name <string>` returning a native Job Object handle kept open for the supervisor lifetime.
- Produces: `Add-Phase7BProcessToJob -Job <handle> -ProcessId <int>` assigning a process to the Job Object.
- Consumes: `$PID` of the Web supervisor before any API/Web `Start-Process` call.

- [ ] **Step 1: Implement Win32 Job Object helper**

Use `CreateJobObject`, `SetInformationJobObject(JobObjectExtendedLimitInformation)`, and `AssignProcessToJobObject`; set `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and throw with Win32 error details on any failure. Do not alter caller shell preferences when the helper is dot-sourced.

- [ ] **Step 2: Integrate before child start**

Dot-source the helper, create the kill-on-close job, assign the current supervisor process `$PID`, and only then start API/Web children. Keep the returned native handle rooted for the supervisor lifetime.

- [ ] **Step 3: Preserve graceful cleanup and handle lifetime**

Keep existing `finally { Stop-ProcessTree ... }`. Do not close the last Job Object handle while the supervisor is alive: on normal shutdown, clean children first and then allow supervisor process exit to close its native handles; on forced supervisor death, Windows closes the process handles and `KILL_ON_JOB_CLOSE` terminates any remaining descendants.

- [ ] **Step 4: Verify GREEN in both shells**

Expected:

```text
PHASE7B_WEB_JOB_OBJECT_CLEANUP_TEST=PASS
FORCED_SUPERVISOR_TERMINATION=DESCENDANTS_CLEANED
AUTOSTART_JOB_OBJECT_ASSIGNMENT=BEFORE_CHILD_START
JOB_OBJECT_HELPER_CALLER_STATE=PRESERVED
```

- [ ] **Step 5: Commit minimal production fix**

Commit message:

```text
fix(phase7b): contain web runtime in kill-on-close job
```

---

### Task 3: Full verification and merge

**Files:**
- No new production scope.

**Interfaces:**
- Consumes: Task 1 RED evidence and Task 2 GREEN implementation.
- Produces: exact CI run, exact feature HEAD SHA, PR, and merge SHA.

- [ ] **Step 1: Run full existing CI**

Require Job Object Windows dual-shell CI plus existing API production runtime and Web build workflows to pass.

- [ ] **Step 2: Review exact diff**

Confirm no changes to Bridge, executors, lifecycle trading controls, ARM/AUTO, MT5 order paths, or account switching.

- [ ] **Step 3: Merge only after all checks pass**

Use a merge commit so RED → GREEN history remains auditable. Record exact merge SHA.

- [ ] **Step 4: Prepare Windows runtime verification**

After merge, verify official `XAUUSD-Phase7B-Web` task using raw `Stop-ScheduledTask` without helper `taskkill`: ports `3711/5717` must close, then official task can be started and safety must remain `DEMO / PAUSE / 0 positions / DISARMED`.
