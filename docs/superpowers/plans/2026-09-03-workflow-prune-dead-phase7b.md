# Dead Phase7B Workflow Pruning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove only Phase7B GitHub Actions workflows that are provably unreachable or unusable after repository consolidation, while preserving every workflow that still has a valid pull-request, manual, deployment, or regression responsibility.

**Architecture:** Treat workflow pruning as repository governance, not trading-runtime work. A permanent governance regression in the always-on canonical PR gate prevents the three proven-dead workflow files from being reintroduced. The implementation deletes only those three workflow YAML files and records the evidence; all other focused workflows remain supplementary and unchanged.

**Tech Stack:** GitHub Actions YAML, Node.js 24 `node:test`, GitHub repository ruleset required checks.

**Spec:** `docs/repository-cleanup/ci-required-checks-map-20260903.md`

## Global Constraints

- SOURCE_ONLY=TRUE
- ORDER_MUTATION=NONE
- LIVE_TEST_ORDER=NONE
- MODE_CHANGE=NONE
- ARM_CHANGE=NONE
- BRIDGE_RESTART=NONE
- EXECUTOR_RESTART=NONE
- WEB_API_RESTART=NONE
- RUNTIME_DEPLOYMENT=NONE
- Preserve `.github/workflows/phase7c-canonical-pr-gate.yml` and required contexts `canonical-pr-linux`, `canonical-pr-windows`.
- Delete a workflow only when current `main` branch topology and workflow content prove it has no valid target/responsibility.

---

### Task 1: Lock the dead-workflow contract

**Files:**
- Create: `scripts/test-repository-workflow-pruning-contract.mjs`
- Modify: `.github/workflows/phase7c-canonical-pr-gate.yml`

**Interfaces:**
- Consumes: current repository filesystem under `.github/workflows`.
- Produces: an always-on test that fails if any of the three retired workflow files exists.

- [ ] **Step 1: Write the failing test**

Create a Node `node:test` contract that asserts these paths do not exist:

```text
.github/workflows/phase7b-live-runtime-status-ci.yml
.github/workflows/phase7b-pattern-rule-v2-apply.yml
.github/workflows/phase7b-pattern-rule-v2-recovery-ci.yml
```

It must also assert `.github/workflows/phase7c-canonical-pr-gate.yml` still exists.

- [ ] **Step 2: Wire the test into the canonical Linux job**

Add exactly one step after `Canonical gate source contract`:

```yaml
- name: Repository workflow pruning contract
  run: node --test scripts/test-repository-workflow-pruning-contract.mjs
```

- [ ] **Step 3: Verify RED on a pull request**

Open a draft PR into `main`. Expected result: `canonical-pr-linux` fails specifically because the three retired workflow files still exist; `canonical-pr-windows` remains unaffected.

### Task 2: Delete only the three proven-dead workflows

**Files:**
- Delete: `.github/workflows/phase7b-live-runtime-status-ci.yml`
- Delete: `.github/workflows/phase7b-pattern-rule-v2-apply.yml`
- Delete: `.github/workflows/phase7b-pattern-rule-v2-recovery-ci.yml`
- Create: `docs/repository-cleanup/workflow-pruning-audit-20260903.md`

**Interfaces:**
- Consumes: the RED contract from Task 1 and current remote topology where only `main` exists before the pruning branch is created.
- Produces: repository tree without the three dead workflow definitions and a durable audit record.

- [ ] **Step 1: Record deletion evidence**

Document:

- `phase7b-live-runtime-status-ci.yml` only targets pull requests whose base is deleted branch `fix/phase7c-legacy-background-cleanup`.
- `phase7b-pattern-rule-v2-apply.yml` pushes/dispatches against deleted branch `phase7c-sideway-supply-demand`, hard-codes checkout of that branch, and writes back to it.
- `phase7b-pattern-rule-v2-recovery-ci.yml` has the same deleted hard-coded target and write-back behavior.
- Phase7B workflows with valid `pull_request` coverage are retained.
- Dedicated Phase7C workflows are not deleted merely because the canonical gate overlaps some tests.

- [ ] **Step 2: Delete the three YAML files**

Delete no other workflow.

- [ ] **Step 3: Verify GREEN**

On the exact new PR head, require both canonical required checks to be `completed/success`. Also require any supplementary workflows triggered by the changed paths to complete successfully.

### Task 3: Merge under protected-main governance

**Files:**
- No additional source files.

**Interfaces:**
- Consumes: exact PR head with all required checks GREEN.
- Produces: protected `main` with the dead workflows removed and the anti-regression contract active.

- [ ] **Step 1: Verify scope**

PR diff must contain only the plan/audit/test/canonical-gate wiring and deletion of the three approved workflow files.

- [ ] **Step 2: Merge through the protected PR path**

Use squash merge only after exact-head required checks are GREEN and mergeability is true.

- [ ] **Step 3: Verify post-merge**

Confirm canonical gate push run is GREEN on the merged `main`, ruleset remains active, open PR count is zero, and the pruning branch is removed after content is preserved on `main`.
