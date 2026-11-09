# Phase7C Bot Mode Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add append-only provenance for every Phase7C bot-mode set while keeping active-mode changes fail-closed and PAUSE safety-first.

**Architecture:** Extend `Phase7CBotModeService` only. The service derives a sibling JSONL audit path from the canonical state file, appends an audit event before any active-mode state mutation, and performs best-effort audit after a PAUSE state mutation. A filesystem behavioral regression test exercises actual temp files and failure modes; CI also builds the API graph.

**Tech Stack:** TypeScript, Node.js filesystem, tsx, Node 24, pnpm 10.18.0, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-25-phase7c-bot-mode-provenance.md`

## Global Constraints

- Keep `phase7c-bot-mode.json` schema unchanged.
- No account switch, LIVE ARM, broker/order/position mutation, strategy/risk/SL/TP/BE/partial, executor-topology, or MT5 panel changes.
- Active modes must not persist if provenance append fails.
- PAUSE must persist even if provenance append fails.

---

### Task 1: Add failing filesystem regression

**Files:**
- Create: `scripts/test-phase7c-bot-mode-provenance.ts`
- Create: `.github/workflows/phase7c-bot-mode-provenance-ci.yml`

**Interfaces:**
- Consumes: `Phase7CBotModeService` and temporary filesystem paths.
- Produces: `PHASE7C_BOT_MODE_PROVENANCE_TEST=PASS` only when append-only history and fail-closed/safety-first behavior are correct.

- [ ] **Step 1: Write the failing behavioral test**

Test these cases with `fs.mkdtempSync()`:

```ts
const service = new Phase7CBotModeService(statePath);
service.set("AUTO", "web-control-center-start");
```

Require sibling `phase7c-bot-mode-audit.jsonl` to contain an event with:

```ts
{
  event: "BOT_MODE_SET_ATTEMPT",
  fromMode: "PAUSE",
  toMode: "AUTO",
  updatedBy: "web-control-center-start"
}
```

Then set another mode and verify JSONL has two ordered lines.

For active fail-closed, pre-create a directory at the audit-file path so append fails, call `set("AUTO", ...)`, require a throw, and require canonical state to remain/match `PAUSE`.

For PAUSE safety-first, seed canonical state as AUTO, keep the audit path unwritable as a directory, call `set("PAUSE", ...)`, require no throw and canonical state to become PAUSE.

- [ ] **Step 2: Verify RED through PR CI**

Run:

```bash
pnpm --filter @xauusd/api exec tsx ../../scripts/test-phase7c-bot-mode-provenance.ts
```

Expected before production implementation: FAIL because the audit JSONL file is not created.

- [ ] **Step 3: Build in the same workflow**

Run after the test:

```bash
pnpm --filter @xauusd/api... build
```

### Task 2: Implement minimal provenance in the bot-mode service

**Files:**
- Modify: `apps/api/src/services/phase7c-bot-mode.service.ts`

**Interfaces:**
- Consumes: current canonical state and requested `BotMode`/`updatedBy`.
- Produces: append-only sibling JSONL events while preserving the existing state schema and return type.

- [ ] **Step 1: Add audit event type/path/helper**

Add `appendFileSync` import, an audit event interface, a private audit path derived as:

```ts
resolve(dirname(this.filePath), "phase7c-bot-mode-audit.jsonl")
```

and a helper that appends exactly one JSON object plus newline.

- [ ] **Step 2: Enforce ordering in `set()`**

Compute the previous state, timestamp, normalized source, next state, and audit event once.

For `AUTO/TREND/SIDEWAY`:

```ts
this.appendAudit(event); // must succeed first
this.writeState(state);
```

For `PAUSE`:

```ts
this.writeState(state); // safety first
try { this.appendAudit(event); } catch { /* PAUSE must remain possible */ }
```

Keep the existing temporary-file + rename atomic state write.

- [ ] **Step 3: Verify GREEN**

Run:

```bash
pnpm --filter @xauusd/api exec tsx ../../scripts/test-phase7c-bot-mode-provenance.ts
pnpm --filter @xauusd/api... build
```

Expected: regression PASS and API build PASS.

### Task 3: Scope review and PR gate

**Files:**
- Review only.

- [ ] **Step 1: Compare against integration base**

Require production diff to be limited to `phase7c-bot-mode.service.ts`; test/workflow/spec/plan are the only other files.

- [ ] **Step 2: Verify CI and existing Phase7C workflows**

Require the dedicated provenance workflow to pass and inspect any existing workflows triggered by the service change.

- [ ] **Step 3: Keep runtime untouched**

Do not run local mode changes, ARM/DISARM, account switching, or broker mutations as part of this PR.
