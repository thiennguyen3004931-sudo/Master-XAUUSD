# Trend Intrabar Next-M15 Pullback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Trend `WAIT_PULLBACK` re-evaluate from the live quote every controller cycle and expire exactly at the close boundary of the immediately following M15 candle.

**Architecture:** Keep pattern discovery on closed M15/M5 data, but decouple an already-pending pullback from the fresh-M5-close gate. Use the current broker quote timestamp for pending lifecycle timing, evaluate terminal expiry/structure/Supertrend invalidations before generic optional entry-condition gating, and preserve all existing order/risk safety guards.

**Tech Stack:** TypeScript, Vitest, pnpm/turbo, GitHub Actions.

**Spec:** Approved conversation scope `TREND_INTRABAR_NEXT_M15_PULLBACK`, captured verbatim in Global Constraints below.

## Global Constraints

- Source-only until PR CI is GREEN.
- No LIVE order, mode, ARM, Bridge, executor, or deployment mutation.
- Initial structural SL `> 10` enters `WAIT_PULLBACK`.
- Pending pullback lives only through the immediately following M15 candle.
- Pending pullback is evaluated every controller cycle; a new closed M5 candle is not required.
- BUY candidate entry uses live `ask`; SELL candidate entry uses live `bid`.
- Structural distance must remain `> 0` and compress to `<= 10` before entry.
- Structure-break and M15/M5 Supertrend invalidation remain fail-closed and win over entry.
- At `timestamp === expiresAt`, pending pullback is expired.
- No broad refactor, forced entry, or safety relaxation.

---

### Task 1: Lock RED contracts

**Files:**
- Modify: `packages/risk-engine/tests/Phase7BPullbackEntryService.test.ts`
- Create: `packages/risk-engine/tests/Phase7BTrendControllerPullbackContract.test.ts`

**Interfaces:**
- Consumes: existing `Phase7BPullbackEntryService` and `scripts/run-phase7b-demo-controller.ts`.
- Produces: regression contracts for exact expiry and intrabar controller wiring.

- [x] **Step 1: Write failing exact-boundary expiry test**

Assert `timestamp === pending.expiresAt` returns `PULLBACK_EXPIRED`.

- [x] **Step 2: Write failing controller contract tests**

Assert the pending block has no `latestM5.closeTime <= lastEvaluatedM5Close` early return, uses `quote.timestamp` for pullback lifecycle timing, evaluates pullback lifecycle before generic strategy-condition entry gating, and fixes the wait window to exactly 15 minutes.

- [x] **Step 3: Verify RED**

PR GitHub Actions reproduced the expected failures before production changes: exact-boundary expiry, fresh-M5 gate, lifecycle ordering, and configurable wait-window contract.

### Task 2: Minimal production fix

**Files:**
- Modify: `packages/risk-engine/src/services/Phase7BPullbackEntryService.ts`
- Modify: `scripts/run-phase7b-demo-controller.ts`

**Interfaces:**
- Consumes: existing `Phase7BPendingPullback`, live quote, closed M15/M5 data, strategy-entry condition snapshot.
- Produces: exact-boundary expiry and intrabar pending evaluation.

- [x] **Step 1: Make expiry boundary inclusive**

Change the service expiry comparison from `timestamp > expiresAt` to `timestamp >= expiresAt` without altering earlier structure/Supertrend invalidation precedence.

- [x] **Step 2: Remove the fresh-M5 gate from pending evaluation**

Do not mutate closed-bar signal-discovery behavior. Only the active pending branch becomes cycle-driven.

- [x] **Step 3: Use broker quote time for pending lifecycle**

Validate `Number(quote.timestamp)` and pass it to `evaluatePullback` instead of `latestM5.closeTime`.

- [x] **Step 4: Evaluate terminal lifecycle before optional entry gating**

Run pullback evaluation after computing condition statuses but before `allEnabledPassed` entry gating. Clear pending on expiry/structure/Supertrend invalidation; keep waiting when distance is still wide or optional enabled entry conditions are not yet satisfied.

- [ ] **Step 5: Verify GREEN**

Targeted apply-run build/typecheck/tests/controller compatibility are GREEN. Require fresh PR workflows on the cleaned final head before marking this complete.

### Task 3: Review and finish branch

**Files:**
- Review only; no runtime/deploy mutation.

**Interfaces:**
- Consumes: GREEN feature branch synced with `main@51f9b6e18591c857cbc8a572d8849de2bf0fd000`.
- Produces: reviewed PR and squash merge only after fresh CI is GREEN.

- [ ] **Step 1: Inspect branch diff against exact synced base `51f9b6e18591c857cbc8a572d8849de2bf0fd000`**
- [ ] **Step 2: Confirm no unrelated runtime/deploy/order changes**
- [ ] **Step 3: Mark PR #212 non-draft after review**
- [ ] **Step 4: Require fresh PR CI GREEN**
- [ ] **Step 5: Squash merge and report exact new `main` SHA**
