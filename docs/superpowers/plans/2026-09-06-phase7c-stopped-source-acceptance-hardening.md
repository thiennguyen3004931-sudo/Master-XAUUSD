# Phase7C Stopped Source Acceptance Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the existing stopped-lifecycle Web/API-only source acceptance path so it fails closed unless the Phase7C executor Scheduled Task is canonically owned/drift-free and inactive runtime-source components are safely classified before and after the rollout.

**Architecture:** Reuse the already-merged `rollout-phase7c-stopped-lifecycle-web-only-local.ps1` path from PR #276 rather than introducing a duplicate wrapper. Extend the GET/read-only safety snapshot with canonical task ownership and runtime-source attestation checks; keep the only approved runtime mutation inside `deploy-phase7c-stopped-lifecycle-web-only-local.ps1`, which stops/starts only `XAUUSD-Phase7B-Web`.

**Tech Stack:** PowerShell 5.1/7, Windows Scheduled Tasks, Phase7C runtime-source attestation, GitHub Actions.

**Spec:** `docs/plans/2026-09-06-phase7c-stopped-lifecycle-web-only.md`

## Global Constraints

- `MODE_MUTATION=NONE`
- `ARM_MUTATION=NONE`
- `BRIDGE_RESTART=NONE`
- `EXECUTOR_RESTART=NONE`
- `ORDER_MUTATION=NONE`
- `POSITION_MUTATION=NONE`
- `LIVE_TEST_ORDER=NONE`
- No new lifecycle/executor start path.
- Keep existing Web-only Scheduled Task stop/start as the sole approved runtime mutation.
- All new checks must fail closed on missing, ambiguous, unreadable, non-canonical, or unexpected evidence.

---

### Task 1: RED source contract for canonical STOPPED acceptance gates

**Files:**
- Modify: `scripts/test-phase7c-stopped-lifecycle-web-only-rollout-source.ps1`

**Interfaces:**
- Consumes: existing safety snapshot and rollout entrypoint.
- Produces: source assertions requiring scheduled-task ownership/drift validation and runtime-source attestation validation.

- [ ] **Step 1:** Require the safety snapshot to import `phase7c-scheduled-task-ownership.ps1` and `phase7c-runtime-source-attestation.ps1`.
- [ ] **Step 2:** Require exact canonical ownership checks using `Test-Phase7CExecutorTaskActionOwnership`, trusted Git runner SHA, and `Get-Phase7CExecutorTaskDrift`.
- [ ] **Step 3:** Require GET `/api/v1/phase7c/runtime-source-attestation` and fail-closed validation for inactive `supervisor`, `trend`, `sideway`, `telegram`, and `regime-notifier` components.
- [ ] **Step 4:** Require explicit safety markers for canonical task ownership/drift and inactive attestation acceptance.
- [ ] **Step 5:** Run the dedicated stopped-lifecycle workflow and capture RED before production code changes.

### Task 2: Minimal production hardening

**Files:**
- Modify: `scripts/snapshot-phase7c-stopped-lifecycle-web-only-safety-local.ps1`

**Interfaces:**
- Consumes: canonical task ownership library, runtime source attestation API, current runtime root.
- Produces: a safety snapshot that proves `PAUSE`, `DISARMED`, lifecycle stopped, flat XAUUSD, stable Bridge, canonical executor task ownership/drift, and safely inactive non-Web Phase7C components.

- [ ] **Step 1:** Import the two canonical libraries without adding mutation primitives.
- [ ] **Step 2:** Resolve the canonical executor runner path and trusted HEAD SHA256; read `XAUUSD-Phase7C-Executors`; require exact owned/canonical/no-repair action, SYSTEM/ServiceAccount/Highest principal, and zero task drift.
- [ ] **Step 3:** Read runtime-source attestation by GET only.
- [ ] **Step 4:** Accept inactive components only when `STALE/alive=false`, except the already-proven `regime-notifier` PID-reuse case, which may be accepted only under the same narrow provenance-only, PID-file-absent, no-wrapper/no-child process evidence used by broker reconciliation.
- [ ] **Step 5:** Emit explicit markers and include the task/attestation safety facts in the returned snapshot.
- [ ] **Step 6:** Re-run PowerShell 7 and Windows PowerShell 5.1 source contracts; require GREEN.

### Task 3: Regression and PR completion

**Files:**
- Modify only if required by CI: `.github/workflows/phase7c-stopped-lifecycle-web-only-ci.yml`

**Interfaces:**
- Consumes: final branch head.
- Produces: CI evidence and merge-ready PR.

- [ ] **Step 1:** Run all PR-triggered workflows and inspect failures.
- [ ] **Step 2:** Verify diff contains only plan/test/snapshot/workflow files unless an additional change is technically required.
- [ ] **Step 3:** Mark PR ready only after all required gates are green.
- [ ] **Step 4:** Merge with expected head SHA and verify new `main` commit.
- [ ] **Step 5:** Do not perform local LIVE rollout from GitHub; provide the exact local acceptance command only after merge verification.
