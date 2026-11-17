# Phase7C Runtime Provenance Recovery Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the canonical LIVE runtime-ready recovery deploy so a trusted-but-legacy/stale-hash Phase7C SYSTEM task is reconciled to the PR #238 SHA256-guarded action before executors are restarted.

**Architecture:** Reuse the existing exact-commit, PAUSE, DISARMED, flat-broker and Bridge-session guards. Inspect Scheduled Task ownership with the merged PR #238 helper; skip task restart when the action is already canonical, but when owned drift requires repair, deploy Web/API first, stop executors, stop the owned SYSTEM task, run the canonical installer with `-Repair`, verify fresh broker heartbeat and canonical ownership, then restart lifecycle and require 5 seconds of stable READY. Foreign or unproven tasks fail closed before mutation.

**Tech Stack:** Windows PowerShell 5.1, PowerShell 7, Windows ScheduledTasks module, GitHub Actions.

**Spec:** User-approved design in the XAUUSD AI MASTER conversation on 2026-09-03.

## Global Constraints

- Exact source must be `main`, clean, and equal to the supplied 40-character `ExpectedCommit`.
- LIVE recovery must begin and end in PAUSE + DISARMED.
- XAUUSD positions and pending orders must remain zero throughout every mutation boundary.
- Bridge must stay healthy and retain the same `bridgeSessionId`; Bridge restart is forbidden.
- No ARM_LIVE, AUTO activation, order mutation, or LIVE test order.
- Only an owned task may be repaired; foreign/unproven task actions fail closed.
- Installer principal replacement remains blocked; canonical task remains SYSTEM + ServiceAccount + Highest.

---

### Task 1: Lock the recovery orchestration contract with RED

**Files:**
- Modify: `scripts/test-phase7c-runtime-ready-stable-recovery-deploy-source.ps1`
- Modify: `.github/workflows/phase7c-runtime-ready-stable-recovery-deploy-ci.yml`

**Interfaces:**
- Consumes: merged PR #238 ownership helper and installer semantics.
- Produces: a failing Windows CI contract requiring task ownership inspection, repair-only sequencing, and canonical skip behavior.

- [ ] **Step 1: Write the failing contract assertions** requiring the recovery helper to load `phase7c-scheduled-task-ownership.ps1`, inspect the canonical runner hash, distinguish canonical from repair-required owned tasks, stop lifecycle before task repair, stop the Scheduled Task before invoking the installer, invoke `register-phase7c-executor-task-local.ps1 -Repair`, verify task ownership/heartbeat after repair, and skip broker-task restart when already canonical.
- [ ] **Step 2: Run Windows CI and verify RED** because the production recovery helper lacks those orchestration tokens/behaviors, not because of syntax or workflow setup errors.
- [ ] **Step 3: Commit the RED contract** before production code.

### Task 2: Implement minimal provenance reconciliation

**Files:**
- Modify: `scripts/recover-phase7c-runtime-ready-stable-deploy-local.ps1`

**Interfaces:**
- Consumes: `Get-Phase7CExecutorTaskRunnerPath`, `Get-Phase7CTrustedGitFileSha256`, `Test-Phase7CExecutorTaskActionOwnership`, `Get-Phase7CScheduledTaskErrorClassification`, and `register-phase7c-executor-task-local.ps1 -Repair`.
- Produces: fail-closed task state classification and a repair path that returns a fresh, canonical SYSTEM broker before lifecycle START.

- [ ] **Step 1: Load the ownership helper and installer path** and validate both files exist before mutation.
- [ ] **Step 2: Compute trusted runner provenance** from accepted Git bytes and inspect the current Scheduled Task action/principal.
- [ ] **Step 3: Fail closed for NOT_FOUND, provider errors, foreign ownership, or non-SYSTEM canonical principal.**
- [ ] **Step 4: Preserve the current fast path** when ownership is canonical and no repair is required: do not stop/restart the broker task merely for provenance.
- [ ] **Step 5: For owned repair-required drift only**, after Web/API deploy and fresh PAUSE/DISARMED/flat/Bridge checks, stop lifecycle if running, verify executors stopped, stop the Scheduled Task, run the installer with `-Repair -ApiUserSid <recorded SID>`, then verify canonical action + trusted SHA256 + SYSTEM principal + fresh broker heartbeat.
- [ ] **Step 6: Restart lifecycle once** and require continuous READY for 5000ms; preserve PAUSE + DISARMED and unchanged Bridge session.
- [ ] **Step 7: On any failure after mutation begins**, retain the existing PAUSE + DISARMED best-effort fail-closed catch path; never ARM/AUTO or restart Bridge.

### Task 3: Verify, review, PR, and merge

**Files:**
- Review all changed files against `main`.

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: mergeable PR with fresh Windows CI and canonical PR gate evidence.

- [ ] **Step 1: Run the targeted recovery workflow** and verify both PowerShell 7 and Windows PowerShell 5.1 contract jobs plus safety regressions pass.
- [ ] **Step 2: Run/observe PR-triggered canonical gates** and inspect any Windows failure logs before changing code.
- [ ] **Step 3: Self-review the exact diff** for unsafe broadening, implicit task termination, ARM/AUTO/order paths, or Bridge restart.
- [ ] **Step 4: Create a non-draft PR** from `fix/phase7c-runtime-provenance-recovery-deploy` to `main`.
- [ ] **Step 5: Verify fresh PR CI against the exact head SHA.**
- [ ] **Step 6: Merge only if all relevant fresh checks pass and the PR remains mergeable at that exact head.**
- [ ] **Step 7: Verify `main` moved to the merge result and report that LIVE deployment itself has not been executed in this source/CI phase.**
