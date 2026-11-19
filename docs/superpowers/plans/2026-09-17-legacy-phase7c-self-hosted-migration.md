# Legacy Phase7C Self-Hosted Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the three remaining legacy Phase7C workflows from GitHub-hosted runners to the proven private Windows self-hosted runner without changing their acceptance logic, and retire one stale branch-only TDD workflow after the canonical pruning gate identified it as unreachable and the cleanup was explicitly approved.

**Architecture:** Preserve every existing job name, trigger, step, command, timeout, shell contract, and security gate in the three migrated workflows. Change only their `runs-on` selectors to `[self-hosted, Windows, X64, xauusd-core-ci]`. The only additional repository mutation authorized after RED evidence is deletion of `.github/workflows/phase7c-broker-desired-state-persistence-tdd.yml`. Require exact-head GREEN evidence from real self-hosted execution.

**Tech Stack:** GitHub Actions, Windows self-hosted runner, PowerShell 7.6.6, Windows PowerShell 5.1, Node.js 24, pnpm 10.18.0, Python 3.12.

**Spec:** `docs/superpowers/specs/2026-09-17-legacy-phase7c-self-hosted-migration-design.md`

## Global Constraints

- `PRODUCTION_MUTATION=NONE`.
- `BOT_RUNTIME_MUTATION=NONE`.
- `MODE_MUTATION=NONE`.
- `ARM_MUTATION=NONE`.
- `TASK_MUTATION=NONE`.
- `PROCESS_MUTATION=NONE`.
- `ORDER_MUTATION=NONE`.
- `POSITION_MUTATION=NONE`.
- `LIVE_TEST_ORDER=NONE`.
- `TRADING_LOGIC_MUTATION=NONE`.
- `RISK_LOGIC_MUTATION=NONE`.
- `ORDER_LOGIC_MUTATION=NONE`.
- `ALLOWLIST_MUTATION=NONE`.
- `GITLEAKS_MUTATION=NONE`.
- `WORKFLOW_SECURITY_DOWNGRADE=NONE`.
- `PS7_GATE_REMOVED=FALSE`.
- `PS5_FALLBACK_USED_TO_BYPASS_PS7=FALSE`.
- Do not modify PR #9, PR #7, or merge PR #10.

---

### Task 1: Capture RED hosted-runner evidence

**Files:**
- Existing: `.github/workflows/phase7c-canonical-pr-gate.yml`
- Existing: `.github/workflows/phase7c-live-arm-orphan-reconciliation-ci.yml`
- Existing: `.github/workflows/phase7c-web-live-arm-demo-auto-ci.yml`

**Interfaces:**
- Consumes: existing `ubuntu-latest` / `windows-latest` runner selectors.
- Produces: exact RED run/job evidence showing pre-step hosted-runner failure.

- [x] **Step 1: Open a Draft PR from `ci/migrate-legacy-phase7c-self-hosted` to `main` before runner-selector changes.**
- [x] **Step 2: Capture the three legacy workflow run IDs and job IDs.**
- [x] **Step 3: Verify failures occur before substantive workflow steps execute.**

RED head and runs:

```text
RED_HEAD=4b18572debe537c8a57327ad1a9ca33e305f4111
CANONICAL_RUN=35191026903
LIVE_ARM_ORPHAN_RUN=35191026894
WEB_LIVE_ARM_RUN=35191026914
ALL_SEVEN_JOBS_FAILED_WITH_STEPS_NULL=TRUE
```

### Task 2: Apply minimal runner-selector migration

**Files:**
- Modify: `.github/workflows/phase7c-canonical-pr-gate.yml`
- Modify: `.github/workflows/phase7c-live-arm-orphan-reconciliation-ci.yml`
- Modify: `.github/workflows/phase7c-web-live-arm-demo-auto-ci.yml`

**Interfaces:**
- Consumes: proven runner labels `[self-hosted, Windows, X64, xauusd-core-ci]` and PS7 capability `7.6.6`.
- Produces: identical jobs executed on the private self-hosted Windows runner.

- [x] **Step 1: Replace every `runs-on: ubuntu-latest` with `runs-on: [self-hosted, Windows, X64, xauusd-core-ci]`.**
- [x] **Step 2: Replace every `runs-on: windows-latest` with `runs-on: [self-hosted, Windows, X64, xauusd-core-ci]`.**
- [x] **Step 3: Preserve every `shell: pwsh` and `shell: powershell` step unchanged.**
- [x] **Step 4: Preserve all build/test/source-contract commands and job/check names unchanged.**
- [x] **Step 5: Commit only the three workflow migrations before evaluating the resulting GREEN run.**

### Task 3: Resolve the pruning blocker discovered by real self-hosted execution

At migration head `9eb69ee602ad85ed80a4cf86c9beef7b6b1ffad7`, the migrated Canonical Gate executed real steps. `canonical-pr-windows` passed, while `canonical-pr-linux` failed only at the existing repository pruning contract:

```text
RUN=35191122309
JOB=105103707494
Repository workflow pruning contract=FAIL
RED_TARGET: branch-dead workflows remain: phase7c-broker-desired-state-persistence-tdd.yml
```

The identified workflow triggered only on `fix/phase7c-broker-desired-state-persistence`; that branch still existed but had no open PR. The user explicitly approved retiring this temporary workflow.

**Authorized cleanup file:**
- Delete: `.github/workflows/phase7c-broker-desired-state-persistence-tdd.yml`

- [x] **Step 1: Verify the pruning failure is unrelated to runner migration, trading logic, risk logic, production state, or PowerShell capability.**
- [x] **Step 2: Verify the temporary workflow is branch-only and has no open PR.**
- [x] **Step 3: Obtain explicit user approval for cleanup.**
- [x] **Step 4: Delete only the stale TDD workflow in a separate cleanup commit on PR #12.**
- [x] **Step 5: Require the canonical pruning contract to pass after deletion.**

Cleanup commit head:

```text
CLEANUP_HEAD=d2a7d0651a94de9c370315341d749db259e1f58d
DELETE_ONLY=.github/workflows/phase7c-broker-desired-state-persistence-tdd.yml
```

### Task 4: Capture exact-head GREEN evidence

**Interfaces:**
- Consumes: migrated workflows plus approved stale-workflow cleanup.
- Produces: run/job logs proving all legacy gates execute on `XAUUSD-CORE-CI-WIN` and the pruning contract is satisfied.

- [x] **Step 1: Require runner labels `self-hosted`, `Windows`, `X64`, `xauusd-core-ci` on each migrated job.**
- [x] **Step 2: Require non-empty executed steps for all migrated jobs.**
- [x] **Step 3: Require both PowerShell 7 and Windows PowerShell 5.1 source contracts to pass wherever both existed before migration.**
- [x] **Step 4: Require Linux-origin Node/build jobs to pass on the self-hosted Windows runner without deleting or weakening commands.**
- [x] **Step 5: Require `Repository workflow pruning contract` to pass.**
- [x] **Step 6: Require canonical private self-hosted CI to pass at the same exact head.**

Pre-documentation-alignment GREEN evidence at `d2a7d0651a94de9c370315341d749db259e1f58d`:

```text
Private Master Core Self-Hosted CI      RUN=35196275806 PASS
Phase7C LIVE Arm Orphan Reconciliation RUN=35196275821 PASS
Phase7C Web LIVE Arm + DEMO Auto       RUN=35196275830 PASS
Phase7C Canonical PR Gate              RUN=35196275786 PASS
  canonical-pr-windows JOB=105120149146 PASS
  canonical-pr-linux   JOB=105120149534 PASS
  Repository workflow pruning contract PASS
```

`Public Private Repository Boundary CI` remains a separate private-repository topology issue owned by PR #9 and is not weakened or bypassed here.

### Task 5: Review diff and hold merge

**Interfaces:**
- Produces: migration acceptance checkpoint.

- [ ] **Step 1: Verify the final diff contains only the three `runs-on` migrations, the explicitly approved stale-workflow deletion, and this spec/plan documentation.**
- [ ] **Step 2: Verify no `continue-on-error`, skipped gate, deleted acceptance test, shell downgrade, public allowlist, Gitleaks, trading/runtime, ARM, order, or position mutation.**
- [ ] **Step 3: Re-run exact-head verification after this documentation alignment.**
- [ ] **Step 4: Keep the migration PR unmerged until exact-head GREEN evidence and final diff review are complete.**
- [ ] **Step 5: Handle PR #9 separately so the public-only boundary workflow can be retired from the private repository before any final merge sequence that requires that check to be green.**
