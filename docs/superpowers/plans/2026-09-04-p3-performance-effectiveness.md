# P3 Performance Effectiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only P3 effectiveness layer that explains entry/management outcomes, reconstructs excursion metrics, and measures the existing intrabar Fast-Move Profit Lock without changing LIVE execution.

**Architecture:** Extend P2 canonical correlation rather than duplicating identity logic. A focused effectiveness service consumes P2 exact-correlation rows, execution journals, and read-only M5 candle evidence, produces evidence-qualified per-trade rows and aggregates, and exposes them through GET-only localhost API plus a collapsed Control Center card. Counterfactual Fast-Move analysis is pure/offline and can never write runtime state.

**Tech Stack:** TypeScript, Node.js, Express, React/Vite, existing Phase7C JSONL journals, MT5 read-only bridge/service patterns, `tsx` semantic tests, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-04-p3-performance-effectiveness.md`

## Global Constraints
- Base commit: `b7ccefcbe8f244f161cb85a456e6b04241c58567`.
- `READ_ONLY=true`.
- `STRATEGY_MUTATION=false`.
- `RISK_MUTATION=false`.
- `ORDER_MUTATION=false`.
- `POSITION_MUTATION=false`.
- `MODE_MUTATION=false`.
- `ARM_MUTATION=false`.
- `AUTO_RETUNE=false`.
- `LIVE_TEST_ORDER=false`.
- Preserve current Fast-Move execution: Trend activation `+10`, giveback `6`; Sideway activation `+10`, giveback `4`; live bid/ask source; +6 BE; monotonic stop; M5 handoff.
- Evidence that is ambiguous or incomplete must remain unknown and must not enter causal aggregates.

---

### Task 1: P3 canonical effectiveness contract

**Files:**
- Create: `apps/api/src/contracts/phase7c-performance-effectiveness.schema.ts`
- Test: `scripts/phase7c-performance-effectiveness-schema.test.ts`

**Interfaces:**
- Consumes: `Phase7CPerformanceCorrelationRow` from `apps/api/src/contracts/phase7c-performance-correlation.schema.ts`.
- Produces: `PHASE7C_PERFORMANCE_EFFECTIVENESS_SCHEMA_VERSION`, `Phase7CPerformanceEffectivenessRow`, `Phase7CPerformanceEffectivenessSnapshot`, management-event and excursion types.

- [ ] **Step 1: Write the failing schema test**

Create a semantic test that imports the new schema and verifies a fully-qualified row can represent: exact correlation, initial risk, MFE/MAE, realized R, Fast-Move current contract, management events, evidence quality, and immutable safety flags. Add negative assertions that `autoApply`, mutation controls, and fabricated numeric defaults are absent.

- [ ] **Step 2: Run RED**

Run:
```bash
pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-performance-effectiveness-schema.test.ts
```
Expected: FAIL because the new contract module does not exist.

- [ ] **Step 3: Implement the minimal contract**

The row must expose nullable evidence-backed fields rather than zero defaults, e.g.:
```ts
export interface Phase7CPerformanceExcursion {
  evidence: "COMPLETE_M5_WINDOW" | "INCOMPLETE" | "UNAVAILABLE";
  mfePrice: number | null;
  maePrice: number | null;
  initialRiskPrice: number | null;
  mfeR: number | null;
  maeR: number | null;
  realizedR: number | null;
  peakToExitGivebackPrice: number | null;
}
```
Management evidence must record event family, timestamp, stop/price when explicit, journal source, and event identity. Fast-Move configuration in the row is descriptive/current-state evidence, not a writable setting.

- [ ] **Step 4: Run GREEN**

Run the schema test and API typecheck/build. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/contracts/phase7c-performance-effectiveness.schema.ts scripts/phase7c-performance-effectiveness-schema.test.ts
git commit -m "feat(phase7c): define P3 effectiveness contract"
```

---

### Task 2: Exact management-event attribution

**Files:**
- Create: `apps/api/src/services/phase7c-performance-management-evidence.service.ts`
- Test: `scripts/phase7c-performance-management-evidence.test.ts`

**Interfaces:**
- Consumes: exact P2 `positionId`, strategy, opened/closed timestamps; runtime root.
- Produces: `getPhase7CManagementEvidence(input)` returning exact/ambiguous/unmatched evidence and normalized event families.

- [ ] **Step 1: Write RED fixtures/tests**

Cover Trend and Sideway JSONL fixtures with explicit tickets for:
```text
PLUS6_SL_TO_ENTRY
PLUS10 / partial close evidence
FAST_MOVE_* tighten/activation/rejected when journaled
FAST_MOVE_HANDOFF_M5_STRUCTURE
M5_STRUCTURAL_SL_TIGHTEN
SIDEWAY_M5_STRUCTURAL_SL_TIGHTEN
FIXED_TP*
RECOVERY*
reversal/close evidence
```
Require events outside `[openedAt, closedAt]` to be excluded. Require ambiguous identity to return `AMBIGUOUS` and not attribute the event.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-performance-management-evidence.test.ts
```
Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement minimal parser**

Read only the existing strategy execution journals. Normalize event names into management families, require explicit ticket/position evidence, preserve source path/event index, and never infer ownership from timestamps alone.

- [ ] **Step 4: Run GREEN plus existing P2 correlation tests**

```bash
pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-performance-management-evidence.test.ts
pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-performance-correlation-schema.test.ts
pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-performance-intelligence.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/phase7c-performance-management-evidence.service.ts scripts/phase7c-performance-management-evidence.test.ts
git commit -m "feat(phase7c): attribute management evidence"
```

---

### Task 3: Read-only M5 excursion reconstruction

**Files:**
- Create: `apps/api/src/services/phase7c-performance-excursion.service.ts`
- Test: `scripts/phase7c-performance-excursion.test.ts`

**Interfaces:**
- Consumes: side, entry, exit, openedAt, closedAt, optional proven initial stop/risk, read-only M5 bars.
- Produces: `evaluatePhase7CExcursion(...)` and a loader that refuses incomplete candle coverage.

- [ ] **Step 1: Write RED tests**

Test BUY and SELL MFE/MAE symmetry, R conversion, peak-to-exit giveback, missing first/last coverage, malformed bars, and zero/unknown initial risk. Assert incomplete coverage returns null metrics rather than estimates.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-performance-excursion.test.ts
```
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement pure evaluator first**

For BUY: `MFE=max(high)-entry`, `MAE=max(0, entry-min(low))`; for SELL: `MFE=entry-min(low)`, `MAE=max(0, max(high)-entry)`. R metrics are nullable unless `initialRiskPrice > 0`. Loader must use read-only bridge/candle access only and prove coverage before calling the evaluator.

- [ ] **Step 4: Run GREEN**

Run excursion tests and API build. Expected: PASS with no bridge write method introduced.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/phase7c-performance-excursion.service.ts scripts/phase7c-performance-excursion.test.ts
git commit -m "feat(phase7c): reconstruct read-only M5 excursions"
```

---

### Task 4: Fast-Move effectiveness and shadow counterfactuals

**Files:**
- Create: `apps/api/src/services/phase7c-fast-move-effectiveness.service.ts`
- Test: `scripts/phase7c-fast-move-effectiveness.test.ts`

**Interfaces:**
- Consumes: evidence-qualified trade path, strategy, current Fast-Move contract, M5/intrabar-equivalent sampled market path when available.
- Produces: current-contract statistics and `SHADOW_ONLY` alternative giveback outcomes.

- [ ] **Step 1: Write RED tests**

Cover:
- Trend current `activation=10/giveback=6` and Sideway current `10/4`.
- BUY/SELL symmetry.
- Peak tracking never decreases favorable peak.
- Alternative Trend givebacks `4,5,7,8`; Sideway `3,5,6`.
- Shadow result cannot contain order/position/SL mutation callbacks or `autoApply=true`.
- Sample `<30` is marked insufficient for recommendation.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-fast-move-effectiveness.test.ts
```
Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement pure replay**

Reuse the same mathematical contract as `scripts/phase7c-fast-move-profit-lock.mjs` but keep P3 code pure/read-only. Do not import an executor that can patch positions. Every alternative output includes `mode: "SHADOW_ONLY"`, sample/coverage metadata, and no write capability.

- [ ] **Step 4: Run GREEN**

Run new test plus existing Fast-Move/stop-monotonicity tests. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/phase7c-fast-move-effectiveness.service.ts scripts/phase7c-fast-move-effectiveness.test.ts
git commit -m "feat(phase7c): measure Fast-Move effectiveness"
```

---

### Task 5: P3 snapshot service and aggregates

**Files:**
- Create: `apps/api/src/services/phase7c-performance-effectiveness.service.ts`
- Test: `scripts/phase7c-performance-effectiveness.test.ts`

**Interfaces:**
- Consumes: P2 correlation backfill/service, management evidence, excursion service, Fast-Move effectiveness service.
- Produces: `getPhase7CPerformanceEffectivenessSnapshot({days, strategy, limit})`.

- [ ] **Step 1: Write RED tests**

Build fixture rows containing exact and ambiguous correlations, complete/incomplete excursion evidence, Trend/Sideway, entry types, regimes, rules, and Fast-Move events. Assert aggregates include only qualified rows and always expose numerator/sample/coverage.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-performance-effectiveness.test.ts
```
Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement minimal service**

Aggregate expectancy, net PnL, win rate, profit factor, R/excursion summaries, management family outcomes, and Fast-Move metrics by strategy/regime/entry type/rule. Preserve the P2 trade identity and correlation evidence in every returned row.

- [ ] **Step 4: Run GREEN and regression suite**

Run P3 tests plus P2 semantic tests and API build. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/phase7c-performance-effectiveness.service.ts scripts/phase7c-performance-effectiveness.test.ts
git commit -m "feat(phase7c): aggregate P3 effectiveness"
```

---

### Task 6: GET-only localhost API and Control Center card

**Files:**
- Create: `apps/api/src/routes/phase7c-performance-effectiveness.route.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/web/src/phase7c-performance-effectiveness-types.ts`
- Create: `apps/web/src/phase7c-performance-effectiveness-api.ts`
- Create: `apps/web/src/ui/Phase7CPerformanceEffectivenessCard.tsx`
- Modify: `apps/web/src/pages/Phase7CControlCenterShellPage.tsx`
- Test: `scripts/test-phase7c-performance-effectiveness-source.mjs`

**Interfaces:**
- API: `GET /api/v1/phase7c/performance-effectiveness` restricted to loopback.
- UI: collapsed by default; no mutation action.

- [ ] **Step 1: Write RED source contract test**

Assert route is GET-only/loopback, response safety flags are immutable/read-only, UI has no POST/PATCH/PUT/DELETE or apply/retune action, and Fast-Move shadow results are visibly labeled.

- [ ] **Step 2: Run RED**

```bash
node scripts/test-phase7c-performance-effectiveness-source.mjs
```
Expected: FAIL because the route/UI do not exist.

- [ ] **Step 3: Implement route/client/card**

Follow P1/P2 localhost/no-store patterns. Card top line shows evidence coverage and current-vs-shadow Fast-Move summary; details show expectancy, R/MFE/MAE, giveback, management events and insufficient-data warnings.

- [ ] **Step 4: Run GREEN and builds**

```bash
node scripts/test-phase7c-performance-effectiveness-source.mjs
pnpm --filter @xauusd/api... build
pnpm --filter @xauusd/web... build
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/phase7c-performance-effectiveness.route.ts apps/api/src/app.ts apps/web/src/phase7c-performance-effectiveness-* apps/web/src/ui/Phase7CPerformanceEffectivenessCard.tsx apps/web/src/pages/Phase7CControlCenterShellPage.tsx scripts/test-phase7c-performance-effectiveness-source.mjs
git commit -m "feat(phase7c): expose P3 effectiveness read-only"
```

---

### Task 7: CI, PR, merge and production acceptance

**Files:**
- Create or modify: `.github/workflows/phase7c-performance-effectiveness-ci.yml`

- [ ] **Step 1: Add dedicated CI paths/commands** covering every P3 contract/service/source test plus API and web builds.
- [ ] **Step 2: Run all P3 tests locally** and the relevant P2/Fast-Move regressions; capture exact PASS counts.
- [ ] **Step 3: Push feature branch and open a non-draft PR** with explicit safety invariants and no strategy/runtime mutation.
- [ ] **Step 4: Require fresh PR CI GREEN** before merge. Do not merge on stale checks.
- [ ] **Step 5: Merge only the tested head**, then verify `main` equals the merge result.
- [ ] **Step 6: Production-accept using the canonical read-only deployment process** and require `POST_DEPLOY_7_COMPONENT_ATTESTATION=PASS`, `COMPONENTS_EXACT_MATCH=7/7`, no LIVE test order, no mode/ARM/order/position mutation.

## Self-review
- Spec coverage: all P3.1–P3.7 sections mapped to Tasks 1–7.
- Fast-Move is measured before any tuning proposal; current runtime thresholds remain unchanged.
- No causal aggregate accepts ambiguous P2 identity or incomplete excursion evidence.
- No production code step precedes a RED test.
- No API/UI mutation path is introduced.
- Counterfactuals remain `SHADOW_ONLY` and sample-gated.