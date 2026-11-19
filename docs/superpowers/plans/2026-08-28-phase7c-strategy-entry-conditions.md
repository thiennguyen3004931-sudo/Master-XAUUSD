# Phase 7C Strategy Entry Conditions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one canonical, versioned, Web-editable strategy-entry-condition profile for Phase 7C Trend and Sideway that applies on the next NEW ENTRY evaluation without executor restart, preserves E1 defaults exactly, locks the required directional anchors, and never weakens safety/risk/orchestration gates.

**Architecture:** A shared pure ESM module under `scripts/` owns condition IDs, defaults, mandatory-anchor rules, validation, PASS/FAIL/IGNORED composition, and config-version comparison. The API owns the single persisted `.runtime/phase7c-strategy-entry-conditions.json` file and guarded whole-state writes. Trend and Sideway read one immutable config snapshot per NEW ENTRY evaluation, keep their approved directional anchors as the sole side origin, and recheck config validity/version at the final order boundary. Web edits only non-mandatory toggles and reads condition telemetry from the existing decision-monitor/audit channel.

**Tech Stack:** Node.js ESM/MJS, TypeScript 5.9 API, Express 4, React 19, MUI 7, TanStack Query 5, pnpm 10.18, repository Node/PowerShell contract tests, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-28-phase7c-strategy-entry-conditions-design.md`, approved amended spec commit `4f56cda197ff40b3515b0b7ae6e41b8c47bbe62a`.

## Global Constraints

- Create implementation branch `feat/phase7c-strategy-entry-conditions` from `design/phase7c-strategy-entry-conditions` after this reviewed plan is committed. Before code, run `git merge-base --is-ancestor 4f56cda197ff40b3515b0b7ae6e41b8c47bbe62a HEAD` and verify this plan file exists in `HEAD`.
- NEW ENTRY only. Do not change HOLD, BE +6, one-third partial +10, structural trailing, TP2, Recovery TP, exit logic, lot/risk, LIVE ARM, account-switch, lifecycle-broker, or Telegram-control semantics.
- DEMO and LIVE share exactly one strategy-condition file. Do not create account-specific strategy-condition profiles.
- Save only when account state is valid, `BOT_MODE=PAUSE`, Bridge/account-mode guards are provable, and XAUUSD positions are exactly `0`.
- Trend `patternM15=true` is mandatory, non-toggleable, and the sole strategy-profile source of Trend BUY/SELL.
- Sideway `rangeEdge=true` is mandatory, non-toggleable, and the sole strategy-profile source of Sideway BUY/SELL.
- Sideway `m5Confirmation` stays independently toggleable and may only confirm the side already selected by `rangeEdge`.
- All enabled conditions use AND. Disabled non-mandatory conditions are `IGNORED`, never `PASS`.
- `recommendedModeSideway` may be disabled only as a strategy observation; canonical `resolveSidewayPermission(...)` routing remains mandatory and outside the profile.
- Internal indicator parameters/thresholds are not editable.
- No executor restart is required for a successful condition-profile save.
- Mid-cycle config invalidation/version change blocks order mutation with `ENTRY_STRATEGY_CONFIG_INVALID` or `ENTRY_CONFIG_VERSION_CHANGED`. Never retry a stale signal.
- No-file state is virtual E1 version `0`; first successful save persists version `1`.
- An existing malformed/invalid persisted file fails closed and normal Web POST cannot silently repair it.
- Only `source="web-control-center"` is accepted by this feature's normal POST path.
- No LIVE or DEMO order test. Use pure/synthetic contracts and order-boundary stubs only.
- During source work do not ARM, enable AUTO, restart Bridge/executors, or mutate positions.
- Every implementation task follows RED -> prove exact RED cause -> minimum production change -> GREEN -> commit.

---

## File Structure Map

### Create

- `scripts/phase7c-strategy-entry-conditions.mjs` — canonical IDs/defaults/validation/evaluator/version guard.
- `scripts/phase7c-strategy-entry-conditions.d.mts` — declarations for API TypeScript import.
- `apps/api/src/services/phase7c-strategy-entry-conditions.service.ts` — canonical persistence plus pure save-guard evaluation.
- `apps/web/src/ui/Phase7CStrategyEntryConditionsCard.tsx` — dedicated Control Center editor/status card.
- `scripts/test-phase7c-strategy-entry-conditions-core-contract.mjs`
- `scripts/test-phase7c-strategy-entry-conditions-api-contract.mjs`
- `scripts/test-phase7c-strategy-entry-conditions-audit-contract.mjs`
- `scripts/test-phase7c-trend-strategy-entry-conditions-contract.mjs`
- `scripts/test-phase7c-sideway-strategy-entry-conditions-contract.mjs`
- `scripts/test-phase7c-strategy-entry-conditions-web-contract.mjs`
- `.github/workflows/phase7c-strategy-entry-conditions-ci.yml`

### Modify

- `apps/api/src/routes/phase7c.route.ts`
- `scripts/phase7c-decision-audit.mjs`
- `apps/api/src/services/phase7c-decision-monitor.service.ts`
- `scripts/run-phase7b-demo-controller.ts`
- `scripts/run-phase7c-sideway-controller.mjs`
- `apps/web/src/phase7c-types.ts`
- `apps/web/src/api.ts`
- `apps/web/src/pages/Phase7CControlCenterShellPage.tsx`

### Explicitly Do Not Modify

- lot-limit behavior or lot-settings semantics;
- LIVE ARM authorization;
- account-switch/recovery implementation;
- lifecycle START/STOP implementation;
- MT5 Bridge trading permission;
- position-management state machines.

---

### Task 1: Shared Canonical Contract and Evaluator

**Files:**
- Create: `scripts/phase7c-strategy-entry-conditions.mjs`
- Create: `scripts/phase7c-strategy-entry-conditions.d.mts`
- Test: `scripts/test-phase7c-strategy-entry-conditions-core-contract.mjs`

**Interfaces:**

```ts
export type Phase7CStrategyName = "TREND" | "SIDEWAY";
export type Phase7CEntrySide = "BUY" | "SELL";
export type Phase7CStrategyConditionStatus = "PASS" | "FAIL" | "IGNORED";
export type Phase7CVersionSnapshot = { version: number; valid: boolean };
```

Public exports:

```js
TREND_STRATEGY_CONDITION_IDS
SIDEWAY_STRATEGY_CONDITION_IDS
STRATEGY_ENTRY_MANDATORY
createVirtualStrategyEntryConditionState()
validateStrategyEntryConditionState(value, options)
evaluateStrategyEntryConditions(input)
compareStrategyEntryConfigVersion(cycleSnapshot, currentSnapshot)
```

- [ ] **Step 1: Write RED core contract**

Create `scripts/test-phase7c-strategy-entry-conditions-core-contract.mjs` with these essential assertions:

```js
import assert from "node:assert/strict";
import {
  STRATEGY_ENTRY_MANDATORY,
  createVirtualStrategyEntryConditionState,
  validateStrategyEntryConditionState,
  evaluateStrategyEntryConditions,
  compareStrategyEntryConfigVersion,
} from "./phase7c-strategy-entry-conditions.mjs";

const defaults = createVirtualStrategyEntryConditionState();
assert.equal(defaults.version, 0);
assert.deepEqual(defaults.trend, {
  patternM15: true,
  supertrendM15: true,
  supertrendM5: true,
  validTrendStructure: true,
  ma20Ma50: false,
  fvg: false,
});
assert.deepEqual(defaults.sideway, {
  rangingRegime: true,
  recommendedModeSideway: true,
  minimumRegimeConfidence: true,
  supplyDemandRange: true,
  rangeEdge: true,
  m5Confirmation: true,
});
assert.deepEqual(STRATEGY_ENTRY_MANDATORY, {
  TREND: ["patternM15"],
  SIDEWAY: ["rangeEdge"],
});

assert.equal(validateStrategyEntryConditionState(defaults, { allowVirtualVersionZero: true }).valid, true);
assert.equal(validateStrategyEntryConditionState({ ...defaults, trend: { ...defaults.trend, patternM15: false } }, { allowVirtualVersionZero: true }).valid, false);
assert.equal(validateStrategyEntryConditionState({ ...defaults, sideway: { ...defaults.sideway, rangeEdge: false } }, { allowVirtualVersionZero: true }).valid, false);

const result = evaluateStrategyEntryConditions({
  strategy: "TREND",
  config: defaults,
  side: "BUY",
  observations: {
    patternM15: { passed: true, observed: "BULLISH_ENGULFING" },
    supertrendM15: { passed: true, observed: "BUY" },
    supertrendM5: { passed: false, observed: "SELL" },
    validTrendStructure: { passed: true, observed: "VALID" },
    ma20Ma50: { passed: false, observed: "SELL" },
    fvg: { passed: false, observed: "NONE" },
  },
});
assert.equal(result.allEnabledPassed, false);
assert.equal(result.conditions.find((row) => row.id === "supertrendM5").status, "FAIL");
assert.equal(result.conditions.find((row) => row.id === "ma20Ma50").status, "IGNORED");
assert.equal(result.conditions.find((row) => row.id === "patternM15").mandatory, true);

assert.deepEqual(
  compareStrategyEntryConfigVersion({ version: 7, valid: true }, { version: 8, valid: true }),
  { ok: false, reasonCode: "ENTRY_CONFIG_VERSION_CHANGED" },
);
assert.deepEqual(
  compareStrategyEntryConfigVersion({ version: 7, valid: true }, { version: 7, valid: false }),
  { ok: false, reasonCode: "ENTRY_STRATEGY_CONFIG_INVALID" },
);
```

Add explicit failures for unknown keys, missing keys, non-boolean conditions, negative version, persisted `version=0`, and zero-enabled invalid sets.

- [ ] **Step 2: Prove RED**

```bash
node scripts/test-phase7c-strategy-entry-conditions-core-contract.mjs
```

Expected: module-not-found for `scripts/phase7c-strategy-entry-conditions.mjs`. Record that exact failure.

- [ ] **Step 3: Implement minimum shared module**

Use exact IDs/defaults:

```js
export const TREND_STRATEGY_CONDITION_IDS = Object.freeze([
  "patternM15", "supertrendM15", "supertrendM5", "validTrendStructure", "ma20Ma50", "fvg",
]);
export const SIDEWAY_STRATEGY_CONDITION_IDS = Object.freeze([
  "rangingRegime", "recommendedModeSideway", "minimumRegimeConfidence", "supplyDemandRange", "rangeEdge", "m5Confirmation",
]);
export const STRATEGY_ENTRY_MANDATORY = Object.freeze({
  TREND: Object.freeze(["patternM15"]),
  SIDEWAY: Object.freeze(["rangeEdge"]),
});
```

`validateStrategyEntryConditionState(...)` returns only:

```js
{ valid: true, state }
// or
{ valid: false, reasonCode: "ENTRY_STRATEGY_CONFIG_INVALID", error: "..." }
```

`evaluateStrategyEntryConditions(...)` returns:

```js
{
  configVersion,
  side,
  anchorCondition,
  enabledCount,
  allEnabledPassed,
  failedConditions,
  conditions: [{ id, enabled, mandatory, status, observed }],
}
```

Mandatory anchors can only be PASS/FAIL. Disabled non-mandatory fields are IGNORED.

- [ ] **Step 4: GREEN**

```bash
node scripts/test-phase7c-strategy-entry-conditions-core-contract.mjs
```

Expected final marker: `PHASE7C_STRATEGY_ENTRY_CORE_CONTRACT=PASS`.

- [ ] **Step 5: Commit**

```bash
git add scripts/phase7c-strategy-entry-conditions.mjs scripts/phase7c-strategy-entry-conditions.d.mts scripts/test-phase7c-strategy-entry-conditions-core-contract.mjs
git commit -m "feat(strategy): add canonical entry condition contract"
```

---

### Task 2: Canonical Persistence and Pure Save Guards

**Files:**
- Create: `apps/api/src/services/phase7c-strategy-entry-conditions.service.ts`
- Test: `scripts/test-phase7c-strategy-entry-conditions-api-contract.mjs`

**Interfaces:**

```ts
export class Phase7CStrategyEntryConditionsService {
  constructor(filePath?: string);
  read(): Phase7CStrategyEntryReadResult;
  set(input: Phase7CStrategyEntryWriteInput): Phase7CStrategyEntryReadResult;
}

export function evaluatePhase7CStrategyEntrySaveGuard(input: {
  mode: string;
  accountStateValid: boolean;
  bridgeReachable: boolean;
  accountModeMatches: boolean;
  openXauusdPositions: number | null;
}): { allowed: true } | { allowed: false; httpStatus: 409; code: string; message: string };
```

- [ ] **Step 1: Add persistence/guard RED assertions**

The API contract must instantiate the service against a temp file:

```js
const service = new Phase7CStrategyEntryConditionsService(tempFile);
const initial = service.read();
assert.equal(initial.valid, true);
assert.equal(initial.persisted, false);
assert.equal(initial.state.version, 0);

const saved = service.set({
  expectedVersion: 0,
  source: "web-control-center",
  trend: initial.state.trend,
  sideway: { ...initial.state.sideway, m5Confirmation: false },
});
assert.equal(saved.state.version, 1);
assert.equal(saved.state.sideway.m5Confirmation, false);
```

Also test: stale version leaves file unchanged; only source `web-control-center` is accepted; mandatory-anchor false is rejected; malformed persisted file returns `valid=false` and cannot be repaired through `set`; atomic write results in complete JSON only; save guard rejects non-PAUSE, invalid account state, unreachable/mismatched Bridge, unknown position count, and positions > 0.

- [ ] **Step 2: Prove RED**

```bash
pnpm --filter @xauusd/api... build
node scripts/test-phase7c-strategy-entry-conditions-api-contract.mjs
```

Expected focused failure: new service/export missing.

- [ ] **Step 3: Implement minimum persistence**

Constructor path:

```ts
this.filePath = filePath?.trim()
  ? resolve(filePath)
  : resolve(process.cwd(), ".runtime", "phase7c-strategy-entry-conditions.json");
```

`read()` contract:

```ts
// no file
{ state: createVirtualStrategyEntryConditionState(), valid: true, persisted: false, error: null }
// valid file
{ state: parsedState, valid: true, persisted: true, error: null }
// existing invalid file
{ state: null, valid: false, persisted: true, error: "..." }
```

`set()` must call `read()`, reject invalid persisted state, require `expectedVersion === current.version`, require `source === "web-control-center"`, validate complete Trend/Sideway payload, increment version exactly once, and write same-directory temp + `renameSync`.

Error codes:

```ts
"ENTRY_STRATEGY_CONFIG_INVALID" | "CONFIG_VERSION_CONFLICT"
```

- [ ] **Step 4: GREEN**

```bash
pnpm --filter @xauusd/api... build
node scripts/test-phase7c-strategy-entry-conditions-api-contract.mjs
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/phase7c-strategy-entry-conditions.service.ts scripts/test-phase7c-strategy-entry-conditions-api-contract.mjs
git commit -m "feat(api): persist strategy entry condition profiles"
```

---

### Task 3: Guarded GET/POST API

**Files:**
- Modify: `apps/api/src/routes/phase7c.route.ts`
- Test: `scripts/test-phase7c-strategy-entry-conditions-api-contract.mjs`

**Interfaces:**

```text
GET  /api/v1/phase7c/strategy-entry-conditions
POST /api/v1/phase7c/strategy-entry-conditions
```

- [ ] **Step 1: Extend API contract to RED on route behavior/source**

Require these response classes:

```text
403 mutation authorization fails
400 schema invalid / mandatory anchor false / unsupported source
409 mode != PAUSE
409 invalid account state
409 Bridge/account-mode/position guard cannot be proven
409 XAUUSD positions > 0
409 CONFIG_VERSION_CONFLICT
409 existing persisted config invalid
200 successful whole-state save
```

GET remains read-only and, if Bridge telemetry is unavailable, returns config validity plus `editable=false` rather than mutating or substituting config.

- [ ] **Step 2: Prove RED**

```bash
node scripts/test-phase7c-strategy-entry-conditions-api-contract.mjs
```

Expected: route endpoints/guard wiring absent.

- [ ] **Step 3: Implement route wiring**

Reuse existing `canChangeBotMode(req)`, `phase7CBotModeService`, `getPhase7CAccountModeState`, `getMt5Telemetry`, and `accountModeAllowsBroker`.

GET shape:

```ts
{
  state: read.valid ? read.state : null,
  valid: read.valid,
  persisted: read.persisted,
  editable,
  error: read.error,
  appliesTo: "NEW_ENTRIES_ONLY",
  sharedAcrossAccounts: true,
  mandatory: { trend: ["patternM15"], sideway: ["rangeEdge"] },
  guards: { mode, accountStateValid, bridgeReachable, accountModeMatches, openXauusdPositions },
  safety: { requiresPause: true, requiresZeroXauusdPositions: true },
}
```

POST sends the complete body into the service only after authorization and `evaluatePhase7CStrategyEntrySaveGuard(...)` pass. Do not accept partial patches or threshold/parameter fields. Do not start/restart executors.

- [ ] **Step 4: GREEN**

```bash
node scripts/test-phase7c-strategy-entry-conditions-api-contract.mjs
pnpm --filter @xauusd/api... build
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/phase7c.route.ts scripts/test-phase7c-strategy-entry-conditions-api-contract.mjs
git commit -m "feat(api): expose guarded strategy entry condition API"
```

---

### Task 4: Audit and Decision-Monitor Observability

**Files:**
- Modify: `scripts/phase7c-decision-audit.mjs`
- Modify: `apps/api/src/services/phase7c-decision-monitor.service.ts`
- Test: `scripts/test-phase7c-strategy-entry-conditions-audit-contract.mjs`

**Interfaces:**

```ts
entryConditions: {
  configVersion: number;
  side: "BUY" | "SELL";
  anchorCondition: "patternM15" | "rangeEdge";
  enabledCount: number;
  allEnabledPassed: boolean;
  failedConditions: string[];
  conditions: Array<{
    id: string;
    enabled: boolean;
    mandatory: boolean;
    status: "PASS" | "FAIL" | "IGNORED";
    observed: unknown;
  }>;
} | null;
```

Decision monitor adds:

```ts
strategyEntryConditions: {
  trend: EntryConditionsDecision | null;
  sideway: EntryConditionsDecision | null;
};
```

- [ ] **Step 1: Write audit RED**

Test `__test.normalizeRecord` preserves the full `entryConditions` object for `ENTRY_STRATEGY_CONDITION_BLOCK`, and that a later safety block keeps its own safety `reasonCode` even if an earlier `ENTRY_STRATEGY_CONDITIONS_PASS` exists.

Example:

```js
assert.equal(record.reasonCode, "ENTRY_STRATEGY_CONDITION_BLOCK");
assert.equal(record.entryConditions.configVersion, 3);
assert.deepEqual(record.entryConditions.failedConditions, ["supertrendM5"]);
```

- [ ] **Step 2: Prove RED**

```bash
node scripts/test-phase7c-strategy-entry-conditions-audit-contract.mjs
```

Expected: audit does not yet preserve/expose strategy-condition telemetry.

- [ ] **Step 3: Implement minimum audit/monitor extension**

In `normalizeRecord` add:

```js
entryConditions: payload?.entryConditions && typeof payload.entryConditions === "object"
  ? payload.entryConditions
  : null,
```

In `buildPhase7CDecisionMonitor`, select the newest audit row per strategy that contains `entryConditions`:

```ts
strategyEntryConditions: {
  trend: input.audit.find((row) => row.strategy === "TREND" && row.entryConditions)?.entryConditions ?? null,
  sideway: input.audit.find((row) => row.strategy === "SIDEWAY" && row.entryConditions)?.entryConditions ?? null,
},
```

Do not change canonical HOLD reason translations and do not make strategy-pass equivalent to trade approval.

- [ ] **Step 4: GREEN plus existing audit/monitor regressions**

```bash
node scripts/test-phase7c-strategy-entry-conditions-audit-contract.mjs
node --test scripts/phase7c-decision-audit.test.mjs
pnpm --dir apps/api exec tsx ../../scripts/phase7c-decision-monitor.test.mjs
pnpm --filter @xauusd/api... build
```

- [ ] **Step 5: Commit**

```bash
git add scripts/phase7c-decision-audit.mjs apps/api/src/services/phase7c-decision-monitor.service.ts scripts/test-phase7c-strategy-entry-conditions-audit-contract.mjs
git commit -m "feat(observability): report strategy entry condition decisions"
```

---

### Task 5: Trend Executor Integration, Including Pending Pullback

**Files:**
- Modify: `scripts/run-phase7b-demo-controller.ts`
- Test: `scripts/test-phase7c-trend-strategy-entry-conditions-contract.mjs`

**Interfaces:**
- `patternM15` remains the only side origin.
- Existing `hasRelevantFvg(m15, index, side, 12)` is the FVG observation; do not create a second FVG definition.
- Existing MA20/MA50 and Supertrend 10,3 calculations are reused unchanged.
- Structural stop/risk-plan validity remains mandatory as a computational/safety prerequisite even if the explicit `validTrendStructure` strategy checkbox is disabled.
- Both immediate entry and a later `PULLBACK_ENTRY` are NEW ENTRY evaluations and must read the current profile for that cycle.

- [ ] **Step 1: Write Trend RED contract**

Require:

```text
E1 == current pattern + M15 ST + M5 ST + valid-structure behavior
patternM15 never IGNORED and owns side
supertrendM15 disabled => IGNORED
supertrendM5 disabled => IGNORED
ma20Ma50 enabled + direction disagreement => FAIL
fvg enabled + hasRelevantFvg(...)=false => FAIL
all enabled conditions PASS => strategy-pass event
immediate path uses one cycle config snapshot
pending-pullback path re-reads current profile on the later pullback cycle
config invalid => no order boundary call
version change before immediate order => ENTRY_CONFIG_VERSION_CHANGED
version change before pullback order => ENTRY_CONFIG_VERSION_CHANGED
```

The test must stub/inspect the order boundary; it must never call a real Bridge.

- [ ] **Step 2: Prove RED**

```bash
node scripts/test-phase7c-trend-strategy-entry-conditions-contract.mjs
```

Expected: current controller hard-codes Supertrend gates and has no profile/version handling.

- [ ] **Step 3: Refactor candidate detection without changing indicator definitions**

Replace the hard pre-evaluator Supertrend rejection in `latestSignal(...)` with a raw candidate stage that originates side only from `detectEntryPattern(...)`, calculates existing observations, and passes them into the shared evaluator.

Observation mapping:

```ts
const observations = {
  patternM15: { passed: true, observed: `${trigger.side}:${trigger.pattern}` },
  supertrendM15: { passed: m15Direction === trigger.side, observed: m15Direction },
  supertrendM5: { passed: m5Direction === trigger.side, observed: m5Direction },
  validTrendStructure: { passed: structuralStopDistance > 0, observed: structuralStopDistance > 0 ? "VALID" : "INVALID" },
  ma20Ma50: {
    passed: trigger.side === "BUY" ? ma20 > ma50 : ma20 < ma50,
    observed: ma20 > ma50 ? "BUY" : ma20 < ma50 ? "SELL" : "FLAT",
  },
  fvg: {
    passed: hasRelevantFvg(m15, index, trigger.side, 12),
    observed: hasRelevantFvg(m15, index, trigger.side, 12) ? trigger.side : "NONE",
  },
};
```

Compute `hasRelevantFvg(...)` once into a local boolean before building this object.

When the strategy gate fails:

```ts
journal("ENTRY_STRATEGY_CONDITION_BLOCK", {
  side: trigger.side,
  entryConditions,
  reason: entryConditions.failedConditions.join(","),
});
```

When it passes, journal `ENTRY_STRATEGY_CONDITIONS_PASS` but continue through all existing safety/risk/pullback logic.

For `state.pendingPullback`, the stored pending side/pattern remains the anchor candidate, but each later M5 evaluation cycle must read current strategy config and recalculate the toggleable confirmations from current canonical data before allowing `PULLBACK_ENTRY`.

Immediately before the existing `/v1/orders` mutation in `submitTrendEntry`, compare the cycle version to a fresh strategy-config read. Block on invalid/mismatch before mutation.

- [ ] **Step 4: GREEN plus exact Trend regressions**

```bash
node scripts/test-phase7c-trend-strategy-entry-conditions-contract.mjs
node scripts/test-phase7c-trend-entry-recovery-contract.mjs
pnpm --filter @xauusd/risk-engine... build
pnpm --filter @xauusd/risk-engine typecheck
pnpm --filter @xauusd/risk-engine test
pnpm --dir apps/api exec tsx ../../scripts/phase7b-live-entry-diagnostics.test.mjs
pnpm --dir apps/api exec tsx ../../scripts/phase7c-decision-monitor.test.mjs
node --test scripts/phase7c-trend-mode-gate.test.mjs
node --test scripts/phase7c-trend-entry-block-classification.test.mjs
pnpm --filter @xauusd/api... build
```

- [ ] **Step 5: Commit**

```bash
git add scripts/run-phase7b-demo-controller.ts scripts/test-phase7c-trend-strategy-entry-conditions-contract.mjs
git commit -m "feat(trend): apply configurable entry condition profile"
```

---

### Task 6: Sideway Executor Integration

**Files:**
- Modify: `scripts/run-phase7c-sideway-controller.mjs`
- Test: `scripts/test-phase7c-sideway-strategy-entry-conditions-contract.mjs`

**Interfaces:**
- Existing `chooseRangeSide(...)` remains mandatory side origin.
- Existing `detectM5Confirmation(m5, side)` is optional when `m5Confirmation=false`.
- Existing `resolveSidewayPermission(...)`, freshness, spread, auto-lot, range-dependent plan construction, and final side-consistency checks stay mandatory.

- [ ] **Step 1: Write Sideway RED contract**

Require:

```text
E1 == current Sideway strategy behavior
rangeEdge cannot be false/IGNORED
rangeEdge uses chooseRangeSide for BUY/SELL
m5Confirmation enabled + match => PASS
m5Confirmation enabled + no match => FAIL
m5Confirmation disabled => IGNORED and does not block
rangingRegime/recommendedModeSideway/minimumRegimeConfidence/supplyDemandRange may become IGNORED when disabled
missing usable range still makes mandatory rangeEdge FAIL
resolveSidewayPermission remains mandatory even if recommendedModeSideway strategy observation is disabled
version mismatch/invalid config before order => no order mutation
```

- [ ] **Step 2: Prove RED**

```bash
node scripts/test-phase7c-sideway-strategy-entry-conditions-contract.mjs
```

Expected: current Sideway controller hard-codes all strategy gates and has no profile/version guard.

- [ ] **Step 3: Implement minimum Sideway composition**

Keep mandatory mode routing outside the evaluator:

```js
const permission = resolveSidewayPermission(activeMode, regime?.recommendedMode);
if (!permission.allowed) {
  journal("ENTRY_MODE_BLOCK", permission);
  return;
}
```

Resolve side only with existing range-edge logic:

```js
const side = regime?.supplyDemandRange
  ? chooseRangeSide(regime.supplyDemandRange, Number(quote.bid), Number(quote.ask))
  : null;
const confirmation = side ? detectM5Confirmation(m5, side) : null;
```

Observation mapping:

```js
const observations = {
  rangingRegime: { passed: regime?.regime === "RANGING", observed: regime?.regime ?? null },
  recommendedModeSideway: { passed: regime?.recommendedMode === "SIDEWAY", observed: regime?.recommendedMode ?? null },
  minimumRegimeConfidence: { passed: Number(regime?.confidence ?? 0) >= minRegimeConfidence, observed: regime?.confidence ?? null },
  supplyDemandRange: { passed: Boolean(regime?.supplyDemandRange), observed: regime?.supplyDemandRange ? "VALID" : "MISSING" },
  rangeEdge: { passed: side === "BUY" || side === "SELL", observed: side },
  m5Confirmation: { passed: Boolean(confirmation && Number(confirmation.closeTime) === closeTime), observed: confirmation?.pattern ?? null },
};
```

Do not retain a separate unconditional `if (!confirmation) return` branch after evaluator integration; the evaluator owns the optional M5 strategy gate. Keep final mandatory mode, freshness, spread, range/plan, auto-lot, and final-side checks.

Immediately before order mutation, re-read profile and apply config-version guard.

- [ ] **Step 4: GREEN plus exact Sideway regressions**

```bash
node scripts/test-phase7c-sideway-strategy-entry-conditions-contract.mjs
node scripts/test-phase7c-sideway-recovery-management-contract.mjs
node --test scripts/phase7c-sideway-logic.test.mjs
node --test scripts/phase7c-sideway-execution-guards.test.mjs
node --test scripts/phase7c-execution-lock.test.mjs
node --test scripts/phase7c-forward-report.test.mjs
node --test scripts/phase7c-decision-audit.test.mjs
pnpm --dir apps/api exec tsx ../../scripts/phase7c-decision-monitor.test.mjs
pnpm --filter @xauusd/api... build
```

- [ ] **Step 5: Commit**

```bash
git add scripts/run-phase7c-sideway-controller.mjs scripts/test-phase7c-sideway-strategy-entry-conditions-contract.mjs
git commit -m "feat(sideway): apply configurable entry condition profile"
```

---

### Task 7: Web Control Center Editor

**Files:**
- Create: `apps/web/src/ui/Phase7CStrategyEntryConditionsCard.tsx`
- Modify: `apps/web/src/phase7c-types.ts`
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/pages/Phase7CControlCenterShellPage.tsx`
- Test: `scripts/test-phase7c-strategy-entry-conditions-web-contract.mjs`

**Interfaces:**

```ts
getPhase7CStrategyEntryConditions(): Promise<Phase7CStrategyEntryConditionsSnapshot>
setPhase7CStrategyEntryConditions(input: Phase7CStrategyEntryConditionsWriteInput): Promise<Phase7CStrategyEntryConditionsSnapshot>
```

Dedicated mutation error:

```ts
export class Phase7CStrategyEntryConditionsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    message: string,
  ) { super(message); }
}
```

- [ ] **Step 1: Write Web RED contract**

Require source/behavior for:

```text
section title "Điều kiện vào lệnh"
copy "Dùng chung DEMO / LIVE" and "NEW ENTRY ONLY"
patternM15 checked + locked
rangeEdge checked + locked
m5Confirmation editable when backend says editable=true
save blocked if canonical state invalid, runtime not editable, draft unchanged, or anchors not true
Khôi phục reloads saved draft only
Khôi phục mặc định chiến lược changes draft only, never POSTs automatically
POST includes expectedVersion and complete Trend/Sideway state
CONFIG_VERSION_CONFLICT reloads latest canonical state and never auto-retries
PASS/FAIL/IGNORED from decision monitor is visible when present
no fields for Supertrend parameters, MA periods, confidence threshold, FVG parameters, or range thresholds
```

- [ ] **Step 2: Prove RED**

```bash
node scripts/test-phase7c-strategy-entry-conditions-web-contract.mjs
```

Expected: component/types/client missing.

- [ ] **Step 3: Add exact Web types and API client**

State type:

```ts
export interface Phase7CStrategyEntryConditionState {
  version: number;
  updatedAt: string;
  updatedBy: string;
  trend: {
    patternM15: boolean;
    supertrendM15: boolean;
    supertrendM5: boolean;
    validTrendStructure: boolean;
    ma20Ma50: boolean;
    fvg: boolean;
  };
  sideway: {
    rangingRegime: boolean;
    recommendedModeSideway: boolean;
    minimumRegimeConfidence: boolean;
    supplyDemandRange: boolean;
    rangeEdge: boolean;
    m5Confirmation: boolean;
  };
}
```

Snapshot `state` is nullable when persisted config is invalid. Its `guards` must match Task 3. Extend `Phase7CDecisionMonitorSnapshot` with `strategyEntryConditions.trend/sideway` matching Task 4.

For this POST use the existing single `API_BASE` transport only. Parse error JSON so `CONFIG_VERSION_CONFLICT` survives as `Phase7CStrategyEntryConditionsApiError.code`; do not add the old two-URL mutation fallback.

- [ ] **Step 4: Implement editor card**

Static row metadata:

```ts
const TREND_ROWS = [
  ["patternM15", "Mô hình nến M15", true],
  ["supertrendM15", "Supertrend M15", false],
  ["supertrendM5", "Supertrend M5", false],
  ["validTrendStructure", "Cấu trúc xu hướng hợp lệ", false],
  ["ma20Ma50", "MA20/MA50 xác nhận", false],
  ["fvg", "FVG xác nhận", false],
] as const;

const SIDEWAY_ROWS = [
  ["rangeEdge", "Giá nằm đúng vùng biên Range", true],
  ["rangingRegime", "Regime = RANGING", false],
  ["recommendedModeSideway", "Recommended Mode = SIDEWAY", false],
  ["minimumRegimeConfidence", "Độ tin cậy regime tối thiểu", false],
  ["supplyDemandRange", "Supply/Demand Range hợp lệ", false],
  ["m5Confirmation", "Xác nhận M5", false],
] as const;
```

Mandatory rows show checked/disabled plus `Bắt buộc · xác định hướng BUY/SELL`. On version conflict: invalidate config query, discard stale draft after reload, show explicit warning, require another manual edit/save.

- [ ] **Step 5: Mount and GREEN**

Shell order:

```tsx
<Stack spacing={3}>
  <Phase7CExecutionAuthorizationCard />
  <Phase7CStrategyEntryConditionsCard />
  <Phase7CControlCenterPage />
</Stack>
```

Run:

```bash
node scripts/test-phase7c-strategy-entry-conditions-web-contract.mjs
pnpm --filter @xauusd/web... build
pnpm --filter @xauusd/api... build
pnpm --filter @xauusd/api exec tsx ../../scripts/test-phase7c-web-mutation-single-transport.ts
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/ui/Phase7CStrategyEntryConditionsCard.tsx apps/web/src/phase7c-types.ts apps/web/src/api.ts apps/web/src/pages/Phase7CControlCenterShellPage.tsx scripts/test-phase7c-strategy-entry-conditions-web-contract.mjs
git commit -m "feat(web): add strategy entry condition editor"
```

---

### Task 8: Focused CI, Safety Regression, Exact SHA

**Files:**
- Create: `.github/workflows/phase7c-strategy-entry-conditions-ci.yml`

**Interfaces:**
- Ubuntu job runs all feature contracts plus exact existing Node/TypeScript regressions.
- Windows job runs exact lifecycle/LIVE-ARM source safety contracts in PowerShell 7 and Windows PowerShell 5.1.
- No job needs MT5 credentials or calls a live/demo order endpoint.

- [ ] **Step 1: Write exact Ubuntu CI commands**

After checkout/setup/install, workflow must run:

```bash
node scripts/test-phase7c-strategy-entry-conditions-core-contract.mjs
node scripts/test-phase7c-strategy-entry-conditions-api-contract.mjs
node scripts/test-phase7c-strategy-entry-conditions-audit-contract.mjs
node scripts/test-phase7c-trend-strategy-entry-conditions-contract.mjs
node scripts/test-phase7c-sideway-strategy-entry-conditions-contract.mjs
node scripts/test-phase7c-strategy-entry-conditions-web-contract.mjs
node scripts/test-phase7c-trend-entry-recovery-contract.mjs
node scripts/test-phase7c-sideway-recovery-management-contract.mjs
pnpm --filter @xauusd/risk-engine... build
pnpm --filter @xauusd/risk-engine typecheck
pnpm --filter @xauusd/risk-engine test
pnpm --filter @xauusd/strategy-engine... build
pnpm --filter @xauusd/strategy-engine typecheck
pnpm --filter @xauusd/strategy-engine test
node --test scripts/phase7c-sideway-logic.test.mjs
node --test scripts/phase7c-sideway-execution-guards.test.mjs
node --test scripts/phase7c-execution-lock.test.mjs
node --test scripts/phase7c-forward-report.test.mjs
node --test scripts/phase7c-lot-settings.test.mjs
node --test scripts/phase7c-lot-range-120.test.mjs
node --test scripts/phase7c-decision-audit.test.mjs
pnpm --dir apps/api exec tsx ../../scripts/phase7b-live-entry-diagnostics.test.mjs
pnpm --dir apps/api exec tsx ../../scripts/phase7c-decision-monitor.test.mjs
node --test scripts/phase7c-trend-mode-gate.test.mjs
node --test scripts/phase7c-trend-entry-block-classification.test.mjs
node --test scripts/phase7c-web-autostart-contract.test.mjs
pnpm --filter @xauusd/api exec tsx ../../scripts/test-phase7c-web-mutation-single-transport.ts
pnpm --filter @xauusd/api... build
node scripts/test-phase7b-api-node-production-runtime.mjs
pnpm --filter @xauusd/web... build
```

- [ ] **Step 2: Write exact Windows safety jobs**

Run each with both `pwsh` and `powershell` where the existing workflow does so:

```powershell
.\scripts\test-phase7c-system-lifecycle-broker-source.ps1
.\scripts\test-phase7c-system-lifecycle-broker-contract.ps1
.\scripts\test-phase7c-lifecycle-broker-acl-source.ps1
.\scripts\test-phase7c-web-live-arm-demo-auto-source.ps1
```

These are source/protocol safety contracts only; do not invoke lifecycle START or any order test.

- [ ] **Step 3: Run complete local/source verification before push**

Run the exact Ubuntu command block from Step 1 on the implementation checkout. Run the Windows source contracts on the Windows verification host when available. Every executed command must exit `0` before PR creation.

- [ ] **Step 4: Verify scope isolation and clean tree**

```bash
git diff --name-only design/phase7c-strategy-entry-conditions...HEAD
git diff --stat design/phase7c-strategy-entry-conditions...HEAD
git status --short
```

Allowed implementation diff is limited to the file map in this plan. `git status --short` must be empty before final SHA capture.

- [ ] **Step 5: Commit CI wiring**

```bash
git add .github/workflows/phase7c-strategy-entry-conditions-ci.yml
git commit -m "ci: verify configurable strategy entry conditions"
```

- [ ] **Step 6: Push PR and require GREEN before merge**

PR branch: `feat/phase7c-strategy-entry-conditions`.

PR safety text must include:

```text
NEW ENTRY configuration only. E1 defaults preserve current behavior. patternM15/rangeEdge are mandatory anchors. m5Confirmation remains optional. Safety/risk/orchestration gates are immutable. No executor restart is required for profile changes. No LIVE/DEMO order test was used.
```

Do not merge while feature-relevant CI is pending/failing.

- [ ] **Step 7: Capture exact completion evidence**

```bash
git rev-parse HEAD
git status --short
git log -1 --oneline
```

Implementation report fields:

```text
RED_PROOF=<focused failing contract and exact cause recorded before production code>
FOCUSED_GREEN=PASS
API_BUILD=PASS
WEB_BUILD=PASS
REGRESSION_GREEN=PASS
GITHUB_CI=PASS
HEAD_SHA=<exact 40-character feature HEAD>
ORDER_TEST=NONE
LIVE_ORDER_TEST=NONE
DEMO_ORDER_TEST=NONE
ARM_MUTATION=NONE
AUTO_MUTATION=NONE
BRIDGE_RESTART=NONE
EXECUTOR_RESTART_FOR_CONFIG=NONE
```

Only after this evidence and CI GREEN may the PR be merged through the repository's normal merge workflow.

---

## Plan Self-Review Results

- Spec A1/B2/C1/D1/E1/F1/G1/G2a each maps to explicit RED contracts and production boundaries.
- Trend `patternM15` and Sideway `rangeEdge` are enforced in shared validation, API, executor semantics, Web UI, and tests.
- Sideway M5 remains toggleable but never becomes a side origin.
- `recommendedModeSideway` cannot disable mandatory `resolveSidewayPermission` routing.
- Missing Supply/Demand data still blocks mandatory `rangeEdge`, even if the explicit `supplyDemandRange` observation is disabled.
- Pending Trend pullback is explicitly treated as a later NEW ENTRY evaluation and cannot use stale config.
- Trend optional FVG reuses existing `hasRelevantFvg(...)`; no duplicate detector is introduced.
- Structural-stop/risk-plan validity remains mandatory as a computational/safety requirement regardless of strategy-checkbox composition.
- Existing invalid persisted config is fail-closed and cannot be silently repaired via normal Web POST.
- Virtual version `0` is never persisted; first persisted version is `1`.
- Optimistic concurrency and final pre-order version race are both covered.
- Web version conflict is typed and never auto-retried.
- Decision monitor exposes a fixed `strategyEntryConditions` shape; strategy-pass remains observability only.
- Exact existing regression commands are listed; no guessed fallback filenames remain.
- No `TBD`, `TODO`, “similar to Task N”, or unresolved implementation placeholder remains.
- No LIVE/DEMO order is required by any task.
