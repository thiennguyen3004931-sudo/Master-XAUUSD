# Private Repository Topology Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove public-only repository migration CI from the private Master/Core repository without weakening the public allowlist or changing trading/runtime behavior.

**Architecture:** The private repository keeps `private-master-core-ci.yml` as its canonical acceptance gate. A private topology contract proves that public-only workflows are absent. The public repository continues to own `public-private-boundary-ci.yml` and `public-distribution-ci.yml` exactly as defined by the approved repository-split design.

**Tech Stack:** GitHub Actions, Node.js 24, node:test, Windows self-hosted runner.

**Spec:** `docs/superpowers/specs/2026-09-15-public-private-repository-split-design.md`

## Global Constraints

- Do not add private Master/Core workflows to the public-safe allowlist.
- Do not weaken or bypass Gitleaks, secret checks, change-freeze rules, or canonical private CI.
- Do not change trading logic, risk logic, order logic, ARM logic, bot mode, production runtime, orders, or positions.
- `PRODUCTION_MUTATION=NONE`.
- `BOT_RUNTIME_MUTATION=NONE`.
- `MODE_MUTATION=NONE`.
- `ARM_MUTATION=NONE`.
- `ORDER_MUTATION=NONE`.
- `POSITION_MUTATION=NONE`.
- `LIVE_TEST_ORDER=NONE`.

---

### Task 1: Prove the topology defect RED

**Files:**
- Create: `scripts/security/private-repository-topology.test.mjs`
- Modify: `.github/workflows/private-master-core-ci.yml`

**Interfaces:**
- Consumes: private repository workflow inventory under `.github/workflows`.
- Produces: a fail-closed test requiring `public-private-boundary-ci.yml` and `public-distribution-ci.yml` to be absent from private Master/Core.

- [x] **Step 1: Write the failing topology test**
- [x] **Step 2: Wire the test into canonical private self-hosted CI**
- [ ] **Step 3: Run exact-head CI and capture RED evidence**

Expected RED: `RED_TARGET: public-only workflows retained in private Master/Core: public-private-boundary-ci.yml`.

### Task 2: Minimal topology fix

**Files:**
- Delete: `.github/workflows/public-private-boundary-ci.yml`

- [ ] **Step 1: Delete only the inherited public-only boundary workflow from private Master/Core**
- [ ] **Step 2: Rerun exact-head private self-hosted CI**
- [ ] **Step 3: Verify topology test GREEN, private CI GREEN, and no trading/runtime mutation**

### Task 3: PR verification

- [ ] **Step 1: Review changed files and diff hygiene**
- [ ] **Step 2: Confirm public allowlist unchanged**
- [ ] **Step 3: Confirm `public-private-boundary-ci.yml` remains owned by the public repository design, not the private repo**
- [ ] **Step 4: Leave PR unmerged until exact-head gates are green**
