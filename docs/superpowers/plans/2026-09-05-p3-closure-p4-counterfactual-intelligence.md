# P3 Closure + P4 Counterfactual Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct P3's stale Fast-Move representation, add a fail-closed read-only P3 production verifier, and deliver a read-only evidence-gated P4 Shadow/Counterfactual Intelligence subsystem with no LIVE auto-retune path.

**Architecture:** P3 remains the canonical observed-effectiveness source. P4 consumes P3 rows and emits versioned scenarios classified `EXACT | BOUNDED | UNAVAILABLE`; nullable counterfactual fields stay null when evidence cannot prove them. API and UI are GET/read-only, and hard safety contracts prohibit runtime, strategy, risk, order, position, mode, ARM, AUTO apply, and LIVE-test-order mutations.

**Tech Stack:** TypeScript, Node.js, Express, React, MUI, TanStack Query, PowerShell 5.1/7 source/runtime verification, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-05-p3-closure-p4-counterfactual-intelligence.md`

## Global Constraints

- Base source at start: `main@1f289a8bcc40ae35579654d0cc97317aafaaa76d`.
- Current canonical Fast-Move contract: activation `10`, giveback `10` for TREND and SIDEWAY.
- `READ_ONLY=true` and P4 `SHADOW_ONLY=true`.
- `STRATEGY_MUTATION=false`, `RISK_MUTATION=false`, `ORDER_MUTATION=false`, `POSITION_MUTATION=false`, `MODE_MUTATION=false`, `ARM_MUTATION=false`.
- `AUTO_APPLY=false`, `AUTO_RETUNE=false`, `LIVE_TEST_ORDER=false`.
- Never infer intrabar ordering from M5 OHLC.
- Null means unproven; do not fabricate counterfactual exit, PnL, R, or recommendation values.
- Production checkout remains pinned until a separately proven controlled rollout; source/CI success is not production acceptance.

---

### Task 1: P3 closure RED + production-verifier contract

**Files:**
- Modify: `scripts/phase7c-performance-effectiveness.test.ts`
- Create: `scripts/test-phase7c-p3-production-acceptance-source.ps1`
- Create later in GREEN: `scripts/verify-phase7c-p3-production-acceptance-local.ps1`

**Interfaces:**
- Consumes: `buildPhase7CPerformanceEffectivenessSnapshotFromRows(...)` and P3 web source.
- Produces: regression assertions that require canonical current contract `activation=10/giveback=10`, plus a source contract requiring a GET-only P3 production verifier.

- [ ] **Step 1: Write the failing P3 contract test**

Add assertions that fixture current contracts are `10/10` and that production source contains no P3 current-contract `6/4` representation.

- [ ] **Step 2: Add the failing verifier source contract**

The PowerShell contract must require a verifier that checks runtime attestation, P3 schema/readOnly/safety, canonical 10/10 current rows when present, and emits explicit mutation-none markers.

- [ ] **Step 3: Push/open draft PR and observe RED**

Expected failure is specifically stale P3 `6/4` and/or missing `verify-phase7c-p3-production-acceptance-local.ps1`, while unrelated builds remain green.

- [ ] **Step 4: Record the RED run/head in the PR body**

No production code is changed before this RED is observed.

### Task 2: P3 closure GREEN

**Files:**
- Modify: `apps/api/src/services/phase7c-performance-effectiveness.service.ts`
- Modify: `apps/web/src/ui/Phase7CPerformanceEffectivenessCard.tsx`
- Modify: `scripts/phase7c-performance-effectiveness.test.ts`
- Create: `scripts/verify-phase7c-p3-production-acceptance-local.ps1`

**Interfaces:**
- Produces P3 current contract `{ activationPrice: 10, givebackPrice: 10, source: "LIVE_BID_ASK" }` for both strategies.
- Verifier accepts `-ProjectRoot`, `-ExpectedCommit`, and optionally localhost API base, performs only GET/read-only checks, and emits deterministic PASS/FAIL markers.

- [ ] **Step 1: Change P3 service current contract to 10/10**
- [ ] **Step 2: Change P3 UI informational text to 10/10**
- [ ] **Step 3: Implement the fail-closed GET-only verifier**
- [ ] **Step 4: Run P3 tests and source contract to GREEN**
- [ ] **Step 5: Commit the minimal P3 closure patch**

### Task 3: P4 canonical schema + pure evaluator RED/GREEN

**Files:**
- Create: `apps/api/src/contracts/phase7c-counterfactual-intelligence.schema.ts`
- Create: `apps/api/src/services/phase7c-counterfactual-evaluator.service.ts`
- Create: `scripts/phase7c-counterfactual-evaluator.test.ts`

**Interfaces:**
- `evaluateFastMoveCounterfactual(input)` consumes strategy, side, entry, observed P3 management evidence, optional ordered exit-side price samples, and alternative giveback.
- Returns a `Phase7CCounterfactualScenario` with verdict `EXACT | BOUNDED | UNAVAILABLE` and nullable outcomes/deltas.

- [ ] **Step 1: Write RED tests** proving ordered samples can yield `EXACT`, management-event-only evidence yields `BOUNDED` with no invented PnL, and absent/non-exact evidence yields `UNAVAILABLE`.
- [ ] **Step 2: Observe RED for missing schema/evaluator**.
- [ ] **Step 3: Implement minimal versioned schema and evaluator**.
- [ ] **Step 4: Run evaluator tests GREEN**.
- [ ] **Step 5: Commit schema/evaluator**.

### Task 4: P4 snapshot aggregation RED/GREEN

**Files:**
- Create: `apps/api/src/services/phase7c-counterfactual-intelligence.service.ts`
- Create: `scripts/phase7c-counterfactual-intelligence.test.ts`

**Interfaces:**
- `buildPhase7CCounterfactualSnapshotFromRows({ rows, generatedAt })` builds scenarios from P3 rows.
- `getPhase7CCounterfactualIntelligence({ days, symbol, limit })` reads P3 and returns the canonical P4 snapshot.

- [ ] **Step 1: RED tests** require Fast-Move grid `4,6,8,12`, rule-observation scenarios, exact/bounded/unavailable counts, coverage, and null-safe delta aggregation.
- [ ] **Step 2: Observe RED**.
- [ ] **Step 3: Implement snapshot service** using P3 rows only, never M5 OHLC ordering assumptions.
- [ ] **Step 4: Run tests GREEN**.
- [ ] **Step 5: Commit snapshot service**.

### Task 5: P4 GET-only localhost API RED/GREEN

**Files:**
- Create: `apps/api/src/routes/phase7c-counterfactual-intelligence.route.ts`
- Modify: `apps/api/src/app.ts`
- Create/modify API source contract test under `scripts/`.

**Interfaces:**
- `GET /api/v1/phase7c/counterfactual-intelligence?days=90&symbol=XAUUSD&limit=100`.
- localhost only; `cache-control: no-store`; no mutation method routes.

- [ ] **Step 1: RED source/API contract** for missing route/mount and mutation-method absence.
- [ ] **Step 2: Observe RED**.
- [ ] **Step 3: Implement route and app mount**.
- [ ] **Step 4: Run API build/contracts GREEN**.
- [ ] **Step 5: Commit API slice**.

### Task 6: P4 Control Center UI RED/GREEN

**Files:**
- Create: `apps/web/src/phase7c-counterfactual-intelligence-types.ts`
- Create: `apps/web/src/phase7c-counterfactual-intelligence-api.ts`
- Create: `apps/web/src/ui/Phase7CCounterfactualIntelligenceCard.tsx`
- Modify: `apps/web/src/pages/Phase7CControlCenterShellPage.tsx`
- Create/modify UI source contract under `scripts/`.

**Interfaces:**
- Card title `P4 · Shadow / Counterfactual Intelligence`.
- Always-visible `READ ONLY`, `SHADOW ONLY`, `AUTO RETUNE: DISABLED`, evidence counts and error state.
- Collapsed-by-default details; 15-second read polling; no save/apply controls.

- [ ] **Step 1: RED UI source contract**.
- [ ] **Step 2: Observe RED**.
- [ ] **Step 3: Implement types/API/card and mount after P3 card**.
- [ ] **Step 4: Run Web build/source contract GREEN**.
- [ ] **Step 5: Commit UI slice**.

### Task 7: Dedicated P4 CI + safety regression

**Files:**
- Create: `.github/workflows/phase7c-counterfactual-intelligence-ci.yml`
- Create: `scripts/test-phase7c-counterfactual-intelligence-source.mjs`
- Modify as required: existing canonical workflow inventory contract only if the repository requires explicit workflow registration.

**Interfaces:**
- Runs P3 closure tests, P4 evaluator/snapshot/source tests, API/Web builds, and safety assertions.

- [ ] **Step 1: Add CI/source contract requiring all P4 files and hard safety literals**.
- [ ] **Step 2: Run on PR exact head**.
- [ ] **Step 3: Fix only failures attributable to this scope**.
- [ ] **Step 4: Require dedicated P4 CI, P3 Performance Effectiveness CI and Canonical PR Gate all GREEN**.

### Task 8: Diff review, PR finalization, merge

**Files:** all changed files above.

- [ ] **Step 1: Review changed-file list** for unexpected strategy/risk/order/executor/Bridge code.
- [ ] **Step 2: Search diff for POST/PUT/PATCH/DELETE apply paths, auto-retune, strategy/config writes, or stale 6/4 P3 current-contract text**.
- [ ] **Step 3: Verify exact-head CI**.
- [ ] **Step 4: Mark PR ready and squash merge using expected head SHA**.
- [ ] **Step 5: Verify merged main commit and signature**.

### Task 9: Production acceptance handoff

**Files:** merged verifier/source only; no automatic production mutation.

- [ ] **Step 1: State that production still runs accepted `85b9adee...` until controlled rollout**.
- [ ] **Step 2: Provide a provenance-verified extraction/run command for the merged P3 acceptance verifier after production is rolled to the new accepted source**.
- [ ] **Step 3: Require P3 production PASS before claiming P3 fully closed**.
- [ ] **Step 4: After a later P4 runtime rollout, use GET-only evidence to prove P4 schema/safety/API and mark P4 production acceptance separately**.
