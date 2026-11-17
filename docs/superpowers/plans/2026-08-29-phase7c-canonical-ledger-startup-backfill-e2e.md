# Phase7C Canonical Ledger Startup Backfill E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining canonical-ledger gap by warming MT5 deal history into the durable ledger on API startup/restart and proving restart-safe historical/idempotent behavior in CI.

**Architecture:** Keep `CanonicalDealLedger` as the sole durable accounting owner. Add one best-effort, read-only startup warmup in the API service that validates the selected Phase7C account against connected MT5 telemetry, derives a bounded historical window from broker quote time, and reuses the existing idempotent `backfillPhase7CCanonicalDealLedger` path. Wire it from `apps/api/src/index.ts` without blocking API startup, and add synthetic tests that exercise startup → history ingestion → persisted ledger → restart replay/older-history merge.

**Tech Stack:** TypeScript, Node.js 24, node:test, pnpm workspace, GitHub Actions.

**Spec:** Project contract `PHASE7C_CANONICAL_DEAL_LEDGER_ACCOUNTING`, remaining startup/restart backfill + historical proof gap from current-main audit.

## Global Constraints

- Deal identity remains `account + MT5 deal ticket` and must stay idempotent.
- Canonical `netPnl = profit + commission + swap + fee` from MT5 deal components.
- No timestamp cursor is introduced.
- Startup warmup is read-only and must not place/modify/cancel/close orders.
- Existing consumers remain on the same canonical ledger: Daily Recovery, MT5 Performance/Web, Telegram PARTIAL/EXIT.
- Account scope must use current MT5 account mode + server + login and must match configured Phase7C account mode before startup ingestion.
- Failure to warm on startup must not crash the API; later canonical consumers retain their existing on-demand backfill path.
- `RUNTIME_MUTATION=NONE`, `ORDER_MUTATION=NONE`, `ARM_CHANGE=NONE`, `MODE_CHANGE=NONE`, `BRIDGE_RESTART=NONE`, `EXECUTOR_RESTART=NONE` for this source/CI scope.

---

### Task 1: RED startup/backfill contract

**Files:**
- Create: `scripts/test-phase7c-canonical-ledger-startup-backfill-contract.mjs`
- Create: `apps/api/src/services/phase7c-canonical-deal-ledger.startup.test.ts`
- Modify: `.github/workflows/phase7c-canonical-deal-ledger-accounting-ci.yml`

**Interfaces:**
- Consumes: current `backfillPhase7CCanonicalDealLedger`, `phase7CCanonicalDealLedgerStatePath`, account-mode state, MT5 telemetry.
- Produces expected contract: `warmPhase7CCanonicalDealLedgerOnStartup()` and an API startup invocation in `apps/api/src/index.ts`.

- [ ] **Step 1: Add source contract that requires startup wiring and forbids mutation paths.**

The test must assert that the canonical service exports `warmPhase7CCanonicalDealLedgerOnStartup`, that `apps/api/src/index.ts` invokes it after startup, that the invocation handles rejection instead of crashing the server, and that neither source contains order mutation endpoints/commands.

- [ ] **Step 2: Add behavior RED test.**

The TypeScript node:test must import `warmPhase7CCanonicalDealLedgerOnStartup`; current production is expected to fail because that export does not yet exist.

- [ ] **Step 3: Extend canonical ledger CI.**

Add the new feature branch and paths, run the source contract before production tests, run the startup behavior test through `pnpm --filter @xauusd/api exec tsx`, then keep existing durable-ledger, consumer migration, notifier lifecycle, dependency builds and diff hygiene.

- [ ] **Step 4: Run CI and record the intended RED.**

Expected failure: missing startup warmup export/wiring, not setup or dependency failure.

---

### Task 2: Minimal startup warm-backfill implementation

**Files:**
- Modify: `apps/api/src/services/phase7c-canonical-deal-ledger.service.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Produces: `warmPhase7CCanonicalDealLedgerOnStartup(deps?) -> Promise<Phase7CCanonicalStartupBackfillResult>`.
- Reuses: `backfillPhase7CCanonicalDealLedger` and the same persisted ledger file.

- [ ] **Step 1: Add a bounded 365-day startup window based on broker quote timestamp.**

The warmup must require connected telemetry with valid account login/server/account mode, require configured Phase7C account mode to match the broker, and calculate `fromMs = max(0, brokerNow - 365 days)`, `toMs = brokerNow`.

- [ ] **Step 2: Reuse the canonical merge path.**

Call the existing backfill function so duplicate prevention, persistence, canonical net P&L and older-than-current history merge remain owned by `CanonicalDealLedger`; do not add a timestamp cursor.

- [ ] **Step 3: Keep startup best-effort.**

Wire `void warmPhase7CCanonicalDealLedgerOnStartup()` from `apps/api/src/index.ts`; log a concise PASS/SKIP/FAIL marker and catch failures so the API can still serve and later consumers can backfill on demand.

- [ ] **Step 4: Run targeted GREEN.**

Expected: source contract PASS, startup behavior PASS, durable ledger tests PASS.

---

### Task 3: Historical/restart E2E proof and full verification

**Files:**
- Modify: `apps/api/src/services/phase7c-canonical-deal-ledger.startup.test.ts`
- Modify: `.github/workflows/phase7c-canonical-deal-ledger-accounting-ci.yml` only if additional path/step coverage is required.

**Interfaces:**
- Consumes startup warmup with dependency injection for deterministic synthetic MT5 history.
- Verifies the real file-backed canonical ledger state path.

- [ ] **Step 1: Prove first startup persists canonical deals.**

Use a temporary `PHASE7C_RUNTIME_ROOT`, synthetic connected LIVE telemetry and a history reader returning a closing MT5 deal whose bridge `netPnl` is intentionally wrong. Assert persisted canonical state recomputes `netPnl` from profit + commission + swap + fee.

- [ ] **Step 2: Prove restart replay is idempotent and older history is not missed.**

Force ledger cache re-open through a temporary alternate runtime root, return to the original root, replay the existing ticket plus an older ticket, and assert the final persisted state contains each ticket once and keeps chronological history without any timestamp cursor.

- [ ] **Step 3: Run full canonical scope CI and applicable PR checks.**

Require canonical durable ledger, startup/backfill behavior, consumer migration, Telegram PARTIAL/EXIT synthetic regression, HOLD regressions, structural SL/Sideway exact one-third, broker/risk/strategy builds/tests, API/Web builds, and `git diff --check`.

- [ ] **Step 4: Review final diff, remove any temporary workflow/helper, open PR and merge only after exact-head checks are GREEN.**
