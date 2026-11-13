# Trend Entry Regime Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the authoritative entry-time AUTO/regime snapshot for every newly authorized Trend order so future canonical-ledger performance audits can attribute Trend trades to BREAKOUT, TRENDING, REVERSAL, or other observed regimes without retrospective inference.

**Architecture:** Keep the existing final Trend order gate as the sole authority. Extend its existing AUTO gate decision with the regime name/confidence already returned by `/api/v1/phase7c/live-regime`, then emit a best-effort canonical decision-audit event immediately after the shared-lock zero-position recheck and immediately before forwarding `/v1/orders`. Do not add another regime request, do not alter allow/block decisions, and do not modify Sideway because its successful `ENTRY_SUBMIT` already captures fresh regime context.

**Tech Stack:** Node.js ESM, TypeScript legacy Trend runtime wrapper, Node test runner, existing Phase7C decision-audit JSONL.

**Spec:** Approved conversation scope `TREND_ENTRY_REGIME_ATTRIBUTION`.

## Global Constraints

- Base exactly `main@33148de8e912a975de407eb60e33515368e8dfd1` unless `main` moves; inspect drift before rebasing.
- Source-only until PR CI is GREEN.
- `ORDER_MUTATION=NONE`.
- `LIVE_TEST_ORDER=NONE`.
- `MODE_CHANGE=NONE`.
- `ARM_CHANGE=NONE`.
- `BRIDGE_RESTART=NONE`.
- `EXECUTOR_RESTART=NONE`.
- `DEPLOY_MUTATION=NONE`.
- No strategy, risk, entry, exit, routing, or Sideway behavior change.
- AUTO attribution must reuse the exact `live-regime` payload already consumed by the final Trend mode gate; no second regime request.
- Manual TREND mode must not fabricate a regime snapshot.
- New observability failure must not reject an otherwise-authorized order.
- Historical six Trend trades remain unattributed unless an authoritative historical source is later found; do not infer their regimes retrospectively.

---

### Task 1: Lock RED contracts

**Files:**
- Modify: `scripts/phase7c-trend-mode-gate.test.mjs`
- Create: `scripts/phase7c-trend-entry-attribution.test.mjs`
- Modify: `.github/workflows/phase7c-reversal-entry-gate-ci.yml`

**Interfaces:**
- Consumes: `evaluateAutoTrendEntryModeGate()` and `scripts/run-phase7c-trend-controller.mjs`.
- Produces: executable RED contracts for authoritative regime propagation, best-effort audit recording, and wrapper integration.

- [ ] **Step 1: Extend mode-gate test input with canonical regime confidence**

Use a `regime` payload containing `activeMode: "AUTO"`, `regime: "TRENDING"`, `recommendedMode: "TREND"`, and `confidence: 0.83`.

- [ ] **Step 2: Assert allowed AUTO decisions expose the exact authoritative snapshot**

Assert `decision.regime === "TRENDING"` and `decision.regimeConfidence === 0.83`; repeat for the REVERSAL exception with its own confidence value.

- [ ] **Step 3: Add attribution helper tests**

Create tests requiring a pure helper to parse a string JSON order body and build payload fields `activeMode`, `recommendedMode`, `regime`, `regimeConfidence`, `permissionReason`, `clientOrderId`, `idempotencyKey`, `side`, `volume`, `stopLoss`, and `takeProfit`. Assert manual TREND decisions leave regime/confidence null. Assert audit `.record()` exceptions are caught and reported through a supplied warning callback rather than thrown.

- [ ] **Step 4: Add wrapper integration source contract**

Read `run-phase7c-trend-controller.mjs` and assert it imports/creates the Trend decision audit, records `ENTRY_FINAL_PERMISSION_GRANTED` after the under-lock position recheck and before `nativeFetch(input, init)`, and contains only the existing canonical `/api/v1/phase7c/live-regime` request path (no duplicate request introduced for attribution).

- [ ] **Step 5: Add the new test to the existing Reversal Entry Gate workflow**

Run `node --test scripts/phase7c-trend-entry-attribution.test.mjs` in `.github/workflows/phase7c-reversal-entry-gate-ci.yml` and include the new test/helper/audit paths in pull-request path filters.

- [ ] **Step 6: Verify RED**

Open a PR from the feature branch if branch push does not trigger the workflow. Expected RED: mode-gate output lacks regime/confidence and the attribution helper/wrapper integration does not yet exist.

---

### Task 2: Minimal production plumbing

**Files:**
- Modify: `scripts/phase7c-trend-mode-gate.mjs`
- Create: `scripts/phase7c-trend-entry-attribution.mjs`
- Modify: `scripts/run-phase7c-trend-controller.mjs`
- Modify: `scripts/phase7c-decision-audit.mjs`

**Interfaces:**
- `evaluateAutoTrendEntryModeGate({ activeMode, regime, demo })` continues returning the existing allow/block fields and additionally returns `regime` and `regimeConfidence` derived solely from its already-supplied `regime` payload.
- `buildTrendEntryAttribution({ decision, requestBody })` returns a plain audit payload and never performs I/O.
- `recordTrendEntryAttributionBestEffort({ audit, decision, requestBody, warn })` returns `{ recorded: boolean, record?: object, error?: string }` and never throws solely because audit persistence fails.

- [ ] **Step 1: Preserve the canonical regime snapshot in AUTO gate decisions**

Normalize regime name as the existing uppercase `regimeName`; normalize confidence only when finite. Add these fields to all AUTO gate result objects without changing `allowed`, `reason`, `recommendedMode`, or detail semantics.

- [ ] **Step 2: Implement pure order-attribution payload construction**

Parse only string `init.body`; never read/consume a `Request` body stream. On invalid/missing body, leave order identity/details null while retaining final permission fields.

- [ ] **Step 3: Implement best-effort recording**

Call `audit.record("ENTRY_FINAL_PERMISSION_GRANTED", payload)` inside try/catch. On failure call `warn()` with a safe message and return failure metadata; do not throw.

- [ ] **Step 4: Wire the final Trend wrapper**

Instantiate `createPhase7CDecisionAudit({ strategy: "TREND", symbol: regimeSymbol })`. Extend `toRequestInfo()` with `body: typeof init?.body === "string" ? init.body : null`. After final permission passes and `positions.length === 0`, invoke the best-effort recorder and only then call the existing `nativeFetch(input, init)`.

- [ ] **Step 5: Make the new event analytics-readable as an entry-ready event**

Add `ENTRY_FINAL_PERMISSION_GRANTED` to the decision-audit stage map as `READY`; rely on existing normalization for `activeMode`, `recommendedMode`, `regime`, and `regimeConfidence`.

- [ ] **Step 6: Verify GREEN targeted tests**

Run the updated mode-gate tests, new attribution tests, parser checks, and existing reversal-entry workflow commands.

---

### Task 3: Full verification and merge

**Files:**
- Review only after Task 2.

**Interfaces:**
- Consumes: feature branch with only Trend attribution/CI/plan changes.
- Produces: merged source checkpoint only after fresh CI is GREEN.

- [ ] **Step 1: Compare branch to exact current `main` and inspect drift**
- [ ] **Step 2: Confirm Sideway source is unchanged**
- [ ] **Step 3: Confirm no lifecycle/deploy/order/risk semantics changed**
- [ ] **Step 4: Require fresh PR CI GREEN on exact final head**
- [ ] **Step 5: Squash merge and verify exact new `main` SHA**
- [ ] **Step 6: Keep LIVE runtime untouched; deployment is a separate guarded operation**
