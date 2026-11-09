# Phase7C Lifecycle READY Acquire + Stable Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Phase7C lifecycle START timing contract so READY may be acquired any time within 50 seconds and, once acquired, receives the full required 5-second stability window without weakening fail-closed behavior.

**Architecture:** Keep the existing runtime READY predicate unchanged. Extract only the timing decision into a small pure exported helper from `phase7c-lifecycle.service.ts`, then drive `waitForReady()` with that helper. The helper distinguishes `WAITING_FOR_READY`, `WAITING_FOR_STABILITY`, `PASS`, and `FAIL` so late READY acquisition can extend only through the stability deadline.

**Tech Stack:** TypeScript, Node.js `node:test`, `tsx`, GitHub Actions.

**Spec:** Production incident evidence on 2026-09-05: broker START completed at 16:36:56.491Z, Telegram first reached READY at 16:37:45.803Z (+49.312s), lifecycle cleanup STOP began at 16:37:46.871Z, while `START_TIMEOUT_MS=50_000` and `START_READY_STABLE_MS=5_000` shared one deadline.

## Global Constraints

- `START_TIMEOUT_MS` remains 50,000 ms for first READY acquisition.
- `START_READY_STABLE_MS` remains 5,000 ms of continuous READY stability.
- Runtime READY predicate is unchanged: broker ready, account state valid, core executor tree running, Telegram ready/fresh, active lot settings alive, and no restart required.
- A readiness flap before 5,000 ms resets stability; if the 50,000 ms acquisition deadline has passed, the wait fails closed.
- If READY never appears by 50,000 ms, the wait fails closed.
- No LIVE ARM, AUTO, order mutation, or runtime retry is part of this source patch.
- Sideway `BROKER_CLOCK_OFFSET_BLOCK` is explicitly out of scope.

---

### Task 1: Add RED timing-contract regression tests

**Files:**
- Create: `apps/api/src/services/phase7c-lifecycle-ready-window.test.ts`
- Create: `.github/workflows/phase7c-lifecycle-ready-window-ci.yml`

**Interfaces:**
- Consumes: `apps/api/src/services/phase7c-lifecycle.service.ts`
- Produces: expected exported function `evaluatePhase7CReadyWindow(input)` used only as a pure timing decision helper.

- [ ] **Step 1: Write the failing test**

Add three behavioral cases using a dynamic namespace lookup so the current source fails with an assertion rather than an import error:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import * as lifecycle from "./phase7c-lifecycle.service";

const evaluate = (lifecycle as any).evaluatePhase7CReadyWindow;

assert.equal(typeof evaluate, "function", "evaluatePhase7CReadyWindow export is required");
```

Then verify:

1. READY first acquired at 49,000 ms and continuously READY through 54,000 ms returns `PASS` only at the stability boundary.
2. READY first acquired at 49,000 ms but flaps false at 52,000 ms returns `FAIL` because the acquisition deadline has already expired.
3. READY never appears through 50,000 ms returns `FAIL`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @xauusd/api exec tsx --test src/services/phase7c-lifecycle-ready-window.test.ts
```

Expected: FAIL with `evaluatePhase7CReadyWindow export is required`.

- [ ] **Step 3: Commit RED only**

```bash
git add apps/api/src/services/phase7c-lifecycle-ready-window.test.ts .github/workflows/phase7c-lifecycle-ready-window-ci.yml docs/superpowers/plans/2026-09-05-phase7c-lifecycle-ready-acquire-stable-window.md
git commit -m "test(phase7c): reproduce late READY stability timeout"
```

### Task 2: Implement minimal acquire + stable timing contract

**Files:**
- Modify: `apps/api/src/services/phase7c-lifecycle.service.ts`
- Test: `apps/api/src/services/phase7c-lifecycle-ready-window.test.ts`

**Interfaces:**
- Produces:

```ts
export type Phase7CReadyWaitDecision =
  | { state: "WAITING_FOR_READY"; readySince: null }
  | { state: "WAITING_FOR_STABILITY"; readySince: number }
  | { state: "PASS"; readySince: number }
  | { state: "FAIL"; readySince: null };

export function evaluatePhase7CReadyWindow(input: {
  startedAt: number;
  now: number;
  ready: boolean;
  readySince: number | null;
  acquireTimeoutMs?: number;
  stableMs?: number;
}): Phase7CReadyWaitDecision;
```

- [ ] **Step 1: Implement the pure helper minimally**

Rules:

```ts
const acquireDeadline = startedAt + acquireTimeoutMs;

if (ready) {
  const nextReadySince = readySince ?? now;
  if (now - nextReadySince >= stableMs) return { state: "PASS", readySince: nextReadySince };
  return { state: "WAITING_FOR_STABILITY", readySince: nextReadySince };
}

if (readySince !== null) {
  return now >= acquireDeadline
    ? { state: "FAIL", readySince: null }
    : { state: "WAITING_FOR_READY", readySince: null };
}

return now >= acquireDeadline
  ? { state: "FAIL", readySince: null }
  : { state: "WAITING_FOR_READY", readySince: null };
```

- [ ] **Step 2: Refactor `waitForReady()` to use the helper**

Capture `startedAt=Date.now()` once. Poll every 500 ms. If helper returns `PASS`, return the current runtime status. If it returns `FAIL`, return `null`. Otherwise persist its `readySince` and continue polling. Do not use one fixed loop deadline that truncates the stability window.

- [ ] **Step 3: Run the focused test and verify GREEN**

```bash
pnpm --filter @xauusd/api exec tsx --test src/services/phase7c-lifecycle-ready-window.test.ts
```

Expected: 3/3 PASS.

- [ ] **Step 4: Build API**

```bash
pnpm --filter @xauusd/api build
```

Expected: PASS.

- [ ] **Step 5: Commit implementation**

```bash
git add apps/api/src/services/phase7c-lifecycle.service.ts
git commit -m "fix(phase7c): preserve READY stability window after late acquire"
```

### Task 3: CI, PR, and merge gate

**Files:**
- No additional production files.

**Interfaces:**
- Consumes: RED/GREEN workflow `Phase7C Lifecycle READY Window CI`.
- Produces: merged `main` commit only after focused timing CI and applicable repository gates pass.

- [ ] **Step 1: Verify exact-head focused CI is GREEN**

Expected workflow command:

```bash
pnpm --filter @xauusd/api exec tsx --test src/services/phase7c-lifecycle-ready-window.test.ts
pnpm --filter @xauusd/api build
```

- [ ] **Step 2: Open PR to `main`**

PR must state the production evidence, exact unchanged safety predicates, and that runtime deployment/retry is not part of the source patch.

- [ ] **Step 3: Verify repository-required CI on PR head**

Do not merge if focused timing CI or canonical Phase7C gates fail.

- [ ] **Step 4: Merge**

Merge only after exact-head gates are GREEN.

### Task 4: Post-merge LIVE acceptance — separate operational checkpoint

**Files:**
- No source changes.

**Interfaces:**
- Consumes: merged source and existing canonical deployment process.
- Produces: runtime evidence only; no order mutation.

- [ ] **Step 1: Deploy canonical merged source with existing production acceptance process**

Keep `BOT_MODE=PAUSE`, `LIVE_ARM=DISARMED`, `XAUUSD_POSITIONS=0`.

- [ ] **Step 2: Run exactly one controlled lifecycle START**

Expected: a late Telegram READY before 50 seconds may continue through the full 5-second stable interval rather than being cleaned up at the 50-second wall.

- [ ] **Step 3: Run strict runtime verifier**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File ".\scripts\verify-phase7c-account-runtime-local.ps1" `
  -WorkDir ".runtime" `
  -ExpectedAccountMode "LIVE" `
  -RequireTelegram
```

Expected: all required Phase7C processes alive and runtime READY. Continue to keep LIVE DISARMED until a separate deliberate operational transition.
