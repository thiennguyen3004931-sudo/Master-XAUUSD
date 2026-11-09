# Phase7C Web LIVE Start Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Web lifecycle Start from ever transitioning a selected LIVE runtime into an active bot mode while preserving existing DEMO Start behavior.

**Architecture:** Keep the guard inside `startPhase7CFromWeb()` at the earliest point after account/runtime state is loaded. LIVE requests fail closed by forcing `PAUSE` and throwing before the existing ready-runtime AUTO path; DEMO continues through the existing ready/cold-start paths unchanged. Lock the ordering and safety contract with the repository's existing source-regression pattern and a dedicated CI workflow.

**Tech Stack:** TypeScript, Node.js source assertions, GitHub Actions, pnpm 10.18.0, Node 24.

**Spec:** `docs/superpowers/specs/2026-08-25-phase7c-web-live-start-guard.md`

## Global Constraints

- Do not ARM or DISARM LIVE.
- Do not switch account mode.
- Do not add broker order/position mutation.
- Do not change Trend/Sideway strategy, SL/TP/BE/partial, lot/risk, executor topology, or MT5 panel order permission.
- LIVE Web Start must fail before any `AUTO` write.
- DEMO Web Start behavior must remain unchanged.

---

### Task 1: Add failing source regression for LIVE Web Start

**Files:**
- Create: `scripts/test-phase7c-web-live-start-guard-source.mjs`
- Create: `.github/workflows/phase7c-web-live-start-guard-ci.yml`

**Interfaces:**
- Consumes: `apps/api/src/services/phase7c-lifecycle.service.ts` source text.
- Produces: `PHASE7C_WEB_LIVE_START_GUARD_SOURCE_TEST=PASS` only when the LIVE guard is ordered before the ready-runtime AUTO branch and required safety strings are present.

- [ ] **Step 1: Write the failing source regression**

Create a Node source assertion that requires:

```js
const accountStateIndex = lifecycle.indexOf("const accountModeState = getPhase7CAccountModeState();");
const liveGuardIndex = lifecycle.indexOf('if (accountModeState.accountMode === "LIVE")');
const readyIndex = lifecycle.indexOf("if (current.ready)");

if (!(accountStateIndex >= 0 && liveGuardIndex > accountStateIndex && readyIndex > liveGuardIndex)) {
  throw new Error("LIVE Web Start guard must execute before ready-runtime AUTO handling");
}
```

It must also require the LIVE branch to write:

```ts
phase7CBotModeService.set("PAUSE", "web-control-center-live-start-blocked")
```

and preserve both existing DEMO AUTO writes using source `web-control-center-start`.

- [ ] **Step 2: Verify RED through PR CI**

Run in CI:

```bash
node scripts/test-phase7c-web-live-start-guard-source.mjs
```

Expected before production fix: FAIL because the existing `if (current.ready)` appears before the LIVE guard.

- [ ] **Step 3: Keep CI scope narrow**

Workflow triggers on pull requests to `fix/phase7c-legacy-background-cleanup` when the lifecycle service, regression script, or workflow changes. It runs the source assertion and `pnpm --filter @xauusd/api... build`.

### Task 2: Implement minimal LIVE fail-closed guard

**Files:**
- Modify: `apps/api/src/services/phase7c-lifecycle.service.ts`

**Interfaces:**
- Consumes: `accountModeState.accountMode`, `phase7CBotModeService`.
- Produces: LIVE Web Start always leaves mode `PAUSE` and throws before any ready-runtime `AUTO` write.

- [ ] **Step 1: Move/add the LIVE branch before `current.ready`**

Minimal implementation:

```ts
const accountModeState = getPhase7CAccountModeState();
const current = getPhase7CLifecycleRuntimeStatus();

if (accountModeState.accountMode === "LIVE") {
  phase7CBotModeService.set("PAUSE", "web-control-center-live-start-blocked");
  throw new Error(
    "Web không được chuyển LIVE sang mode hoạt động. LIVE phải được kích hoạt qua flow operator/ARM riêng; Bot vẫn PAUSE.",
  );
}

if (current.ready) {
  // existing DEMO ready behavior remains unchanged
}
```

Remove the now-unreachable later LIVE cold-start block only after the early guard is in place. Do not modify DEMO launch/final-preflight logic.

- [ ] **Step 2: Verify GREEN**

Run:

```bash
node scripts/test-phase7c-web-live-start-guard-source.mjs
pnpm --filter @xauusd/api... build
```

Expected: source regression PASS and API dependency build PASS.

- [ ] **Step 3: Inspect diff for scope and mutation safety**

Confirm changed production code is limited to lifecycle Web Start guard ordering/message/source label, with no `/v1/orders`, `order_send`, account-switch, ARM-file, strategy, risk, or executor-launch behavior added.

### Task 3: PR verification and merge readiness

**Files:**
- Review only; no additional production files unless verification exposes a defect.

**Interfaces:**
- Consumes: PR diff, CI results, commit status.
- Produces: merge-ready PR only after all checks are green.

- [ ] **Step 1: Review final diff**

Compare branch against `fix/phase7c-legacy-background-cleanup`; expected scope is spec/plan, one source regression, one workflow, and one lifecycle service edit.

- [ ] **Step 2: Verify CI**

Require the dedicated Web LIVE Start Guard workflow to pass and verify no failing required checks on the head commit.

- [ ] **Step 3: Merge only after GREEN evidence**

Merge into `fix/phase7c-legacy-background-cleanup` only after final verification. Do not alter local runtime state as part of merge.
