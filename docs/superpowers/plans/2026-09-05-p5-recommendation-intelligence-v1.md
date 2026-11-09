# P5 Recommendation Intelligence V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, read-only Phase7C recommendation layer that converts canonical P2/P3/P4 evidence into auditable `KEEP_CURRENT | REVIEW_CHANGE | COLLECT_MORE_EVIDENCE | UNAVAILABLE` recommendations without any LIVE auto-apply or auto-retune capability.

**Architecture:** P5 consumes the existing P3 Performance Effectiveness snapshot and P4 Counterfactual Intelligence snapshot through service APIs already in-process; it does not reread journals or create a second replay engine. A pure deterministic evaluator produces candidate recommendations, a composition service assembles the canonical snapshot, one localhost GET-only route exposes it, and a collapsed Control Center card renders advisory output with stale-refetch handling.

**Tech Stack:** TypeScript, Node 24, Express, React, React Query, MUI, pnpm 10.18.0, tsx-based semantic tests, PowerShell 7 / Windows PowerShell 5.1 production-acceptance source contracts, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-05-p5-recommendation-intelligence-v1-design.md`

## Global Constraints

- `READ_ONLY=TRUE`
- `ADVISORY_ONLY=TRUE`
- `AUTO_APPLY=FALSE`
- `AUTO_RETUNE=FALSE`
- `STRATEGY_MUTATION=FALSE`
- `RISK_MUTATION=FALSE`
- `ORDER_MUTATION=FALSE`
- `POSITION_MUTATION=FALSE`
- `MODE_MUTATION=FALSE`
- `ARM_MUTATION=FALSE`
- `RUNTIME_RESTART=NONE`
- `LIVE_TEST_ORDER=NONE`
- `MIN_SAMPLE_FOR_REVIEW=10`
- `MIN_SAMPLE_FOR_HIGH_CONFIDENCE=30`
- P4 `BOUNDED` evidence can never produce `HIGH` confidence.
- P3 observational aggregates alone can never produce `REVIEW_CHANGE` for `RULE` or `ENTRY_TYPE`.
- Null/unproved P4 PnL or realized-R must remain null; P5 must never infer them from P3.
- V1 creates one recommendation candidate per canonical target key for `RULE`, `ENTRY_TYPE`, and `MANAGEMENT`; no per-regime/per-strategy target splitting.
- Production rollout is out of scope for source implementation; production acceptance is a separate guarded step after merge.

---

## File Structure

**Create API domain files**
- `apps/api/src/contracts/phase7c-recommendation-intelligence.schema.ts` — canonical P5 schema, safety flags, candidate/action/confidence/reason-code types.
- `apps/api/src/services/phase7c-recommendation-evaluator.service.ts` — pure deterministic scoring/gating logic; no I/O.
- `apps/api/src/services/phase7c-recommendation-intelligence.service.ts` — P3/P4 composition and candidate construction.
- `apps/api/src/routes/phase7c-recommendation-intelligence.route.ts` — localhost GET-only route with query validation and `cache-control: no-store`.

**Modify API composition**
- `apps/api/src/app.ts` — mount only `GET /api/v1/phase7c/recommendation-intelligence` router.

**Create Web files**
- `apps/web/src/phase7c-recommendation-intelligence-types.ts` — browser mirror of P5 response types.
- `apps/web/src/phase7c-recommendation-intelligence-api.ts` — GET client with `cache: no-store`.
- `apps/web/src/ui/Phase7CRecommendationIntelligenceCard.tsx` — collapsed advisory-only card with stale-refetch distinction.

**Modify Web composition**
- `apps/web/src/pages/Phase7CControlCenterShellPage.tsx` — mount P5 after P4 and before runtime-source attestation.

**Create tests/verification**
- `scripts/test-phase7c-recommendation-intelligence-source.mjs` — source/safety/UI/API route contract.
- `scripts/phase7c-recommendation-evaluator.test.ts` — deterministic semantic tests.
- `scripts/phase7c-recommendation-intelligence.test.ts` — composition snapshot tests against synthetic P3/P4 inputs.
- `scripts/test-phase7c-recommendation-api-source.mjs` — GET-only route contract and forbidden mutation route/control checks.
- `scripts/test-phase7c-p5-production-acceptance-source.ps1` — source contract for verifier.
- `scripts/verify-phase7c-p5-production-acceptance-local.ps1` — GET-only production acceptance verifier; no restart/mutation.
- `.github/workflows/phase7c-recommendation-intelligence-ci.yml` — dedicated P5 CI plus P2/P3/P4 regression coverage.

---

### Task 1: RED Source and Safety Contracts

**Files:**
- Create: `scripts/test-phase7c-recommendation-intelligence-source.mjs`
- Create: `scripts/test-phase7c-recommendation-api-source.mjs`

**Interfaces:**
- Consumes: current repository source at branch base.
- Produces: RED contracts that define the required P5 files, schema literals, GET-only route, UI safety labels, absence of apply/retune mutation surfaces.

- [ ] **Step 1: Write the failing P5 source contract**

Create `scripts/test-phase7c-recommendation-intelligence-source.mjs` with assertions equivalent to:

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(root, relative));

const required = [
  "apps/api/src/contracts/phase7c-recommendation-intelligence.schema.ts",
  "apps/api/src/services/phase7c-recommendation-evaluator.service.ts",
  "apps/api/src/services/phase7c-recommendation-intelligence.service.ts",
  "apps/api/src/routes/phase7c-recommendation-intelligence.route.ts",
  "apps/web/src/phase7c-recommendation-intelligence-types.ts",
  "apps/web/src/phase7c-recommendation-intelligence-api.ts",
  "apps/web/src/ui/Phase7CRecommendationIntelligenceCard.tsx",
];
for (const file of required) assert.equal(exists(file), true, `missing ${file}`);

const schema = read(required[0]);
for (const literal of [
  "phase7c-recommendation-intelligence-v1",
  '"KEEP_CURRENT"',
  '"REVIEW_CHANGE"',
  '"COLLECT_MORE_EVIDENCE"',
  '"UNAVAILABLE"',
  '"HIGH"',
  '"MEDIUM"',
  '"LOW"',
  '"NONE"',
  "autoApply: false",
  "autoRetune: false",
  "advisoryOnly: true",
]) assert.match(schema, new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
```

Add source assertions that the card contains `READ ONLY`, `ADVISORY ONLY`, `AUTO APPLY: DISABLED`, `AUTO RETUNE: DISABLED`, and does not contain button/control labels `Apply`, `Retune`, `Accept & Apply`, or mutation calls.

- [ ] **Step 2: Write the failing GET-only API source contract**

Create `scripts/test-phase7c-recommendation-api-source.mjs` that reads the route and `app.ts` and requires:

```js
assert.match(route, /router\.get\("\/"/);
assert.doesNotMatch(route, /router\.(post|put|patch|delete)\(/i);
assert.match(route, /cache-control/);
assert.match(route, /no-store/);
assert.match(app, /phase7c\/recommendation-intelligence/);
for (const forbidden of ["apply", "retune", "save", "strategyMutation", "orderMutation"]) {
  assert.equal(route.toLowerCase().includes(`router.post(\"/${forbidden}`), false);
}
```

- [ ] **Step 3: Run RED contracts**

Run:

```bash
node scripts/test-phase7c-recommendation-intelligence-source.mjs
node scripts/test-phase7c-recommendation-api-source.mjs
```

Expected: both FAIL because P5 production source is absent.

- [ ] **Step 4: Commit RED only**

```bash
git add scripts/test-phase7c-recommendation-intelligence-source.mjs scripts/test-phase7c-recommendation-api-source.mjs
git commit -m "test(phase7c): define P5 recommendation intelligence RED contracts"
```

---

### Task 2: Canonical Schema and Deterministic Evaluator

**Files:**
- Create: `apps/api/src/contracts/phase7c-recommendation-intelligence.schema.ts`
- Create: `apps/api/src/services/phase7c-recommendation-evaluator.service.ts`
- Create: `scripts/phase7c-recommendation-evaluator.test.ts`

**Interfaces:**
- Consumes: `Phase7CPerformanceEffectivenessMetricBucket`, `Phase7CCounterfactualEvidenceVerdict`, explicit P4 deltas.
- Produces:
  - `PHASE7C_RECOMMENDATION_INTELLIGENCE_SCHEMA_VERSION`
  - `phase7CRecommendationSafety()`
  - `evaluatePhase7CRecommendationCandidate(input): Phase7CRecommendationDecision`
  - constants `MIN_SAMPLE_FOR_REVIEW=10`, `MIN_SAMPLE_FOR_HIGH_CONFIDENCE=30`.

- [ ] **Step 1: Write evaluator RED semantic tests**

Create `scripts/phase7c-recommendation-evaluator.test.ts` covering at least these exact cases:

```ts
import assert from "node:assert/strict";
import { evaluatePhase7CRecommendationCandidate } from "../apps/api/src/services/phase7c-recommendation-evaluator.service";

const base = {
  targetScope: "MANAGEMENT" as const,
  targetKey: "FAST_MOVE_TIGHTEN",
  sampleSize: 12,
  lineageExact: true,
  p3Qualified: true,
  p4Verdict: "BOUNDED" as const,
  comparableDelta: 2,
  counterfactualNetPnlDelta: null,
  counterfactualRealizedRDelta: null,
  conflict: false,
};

assert.equal(evaluatePhase7CRecommendationCandidate(base).action, "REVIEW_CHANGE");
assert.equal(evaluatePhase7CRecommendationCandidate(base).confidence, "MEDIUM");

assert.notEqual(
  evaluatePhase7CRecommendationCandidate({ ...base, sampleSize: 9 }).action,
  "REVIEW_CHANGE",
);

assert.notEqual(
  evaluatePhase7CRecommendationCandidate({ ...base, p4Verdict: "UNAVAILABLE" }).action,
  "REVIEW_CHANGE",
);

assert.notEqual(
  evaluatePhase7CRecommendationCandidate({ ...base, conflict: true }).action,
  "REVIEW_CHANGE",
);

assert.notEqual(
  evaluatePhase7CRecommendationCandidate({
    ...base,
    targetScope: "RULE",
    p4Verdict: "UNAVAILABLE",
    comparableDelta: null,
  }).action,
  "REVIEW_CHANGE",
);
```

Also assert:
- BOUNDED never yields `HIGH`, even at n=100.
- EXACT n=30 + positive comparable delta + no conflict can yield `HIGH`.
- EXACT/BOUNDED with non-positive comparable delta and sufficient evidence yields `KEEP_CURRENT`.
- `lineageExact=false` yields `UNAVAILABLE` with `EXACT_LINEAGE_REQUIRED`.
- `comparableDelta=null` yields `COLLECT_MORE_EVIDENCE` with `MISSING_COMPARABLE_DELTA`.
- null PnL/R remain null in decision evidence.

- [ ] **Step 2: Run evaluator RED test**

```bash
pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-recommendation-evaluator.test.ts
```

Expected: FAIL because schema/evaluator do not exist.

- [ ] **Step 3: Implement canonical schema**

Create `apps/api/src/contracts/phase7c-recommendation-intelligence.schema.ts` with these core types:

```ts
export const PHASE7C_RECOMMENDATION_INTELLIGENCE_SCHEMA_VERSION =
  "phase7c-recommendation-intelligence-v1" as const;

export type Phase7CRecommendationTargetScope = "RULE" | "ENTRY_TYPE" | "MANAGEMENT";
export type Phase7CRecommendationAction =
  | "KEEP_CURRENT"
  | "REVIEW_CHANGE"
  | "COLLECT_MORE_EVIDENCE"
  | "UNAVAILABLE";
export type Phase7CRecommendationConfidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export type Phase7CRecommendationReasonCode =
  | "EXACT_LINEAGE_REQUIRED"
  | "INSUFFICIENT_SAMPLE"
  | "COUNTERFACTUAL_UNAVAILABLE"
  | "COUNTERFACTUAL_RULE_REPLAY_UNAVAILABLE"
  | "COUNTERFACTUAL_ENTRY_REPLAY_UNAVAILABLE"
  | "BOUNDED_DIRECTIONAL_EVIDENCE"
  | "EXACT_IMPROVEMENT_EVIDENCE"
  | "NO_PROVEN_IMPROVEMENT"
  | "EVIDENCE_CONFLICT"
  | "MISSING_COMPARABLE_DELTA"
  | "PNL_NOT_PROVABLE"
  | "REALIZED_R_NOT_PROVABLE"
  | "HIGH_CONFIDENCE_SAMPLE_NOT_MET";

export interface Phase7CRecommendationSafety {
  readOnly: true;
  advisoryOnly: true;
  runtimeMutation: false;
  strategyMutation: false;
  riskMutation: false;
  orderMutation: false;
  positionMutation: false;
  modeMutation: false;
  armMutation: false;
  autoApply: false;
  autoRetune: false;
  liveTestOrder: false;
}
```

Define candidate and snapshot interfaces with `evidenceScore`, `evidenceScoreIsNotProbability: true`, P2/P3/P4 summaries, action/confidence/reasons/limitations, and nullable comparable/PnL/R deltas.

- [ ] **Step 4: Implement deterministic evaluator**

Create `apps/api/src/services/phase7c-recommendation-evaluator.service.ts` with a pure input:

```ts
export const MIN_SAMPLE_FOR_REVIEW = 10;
export const MIN_SAMPLE_FOR_HIGH_CONFIDENCE = 30;

export interface Phase7CRecommendationEvaluationInput {
  targetScope: Phase7CRecommendationTargetScope;
  targetKey: string;
  sampleSize: number;
  lineageExact: boolean;
  p3Qualified: boolean;
  p4Verdict: "EXACT" | "BOUNDED" | "UNAVAILABLE";
  comparableDelta: number | null;
  counterfactualNetPnlDelta: number | null;
  counterfactualRealizedRDelta: number | null;
  conflict: boolean;
  unavailableReason?: Phase7CRecommendationReasonCode;
}
```

Use this fail-closed gate order:

```ts
if (!input.lineageExact) return unavailable("EXACT_LINEAGE_REQUIRED");
if (input.conflict) return unavailable("EVIDENCE_CONFLICT");
if (input.p4Verdict === "UNAVAILABLE") {
  return collectOrUnavailable(input.unavailableReason ?? "COUNTERFACTUAL_UNAVAILABLE");
}
if (input.sampleSize < MIN_SAMPLE_FOR_REVIEW) return collect("INSUFFICIENT_SAMPLE");
if (input.comparableDelta === null) return collect("MISSING_COMPARABLE_DELTA");
if (input.comparableDelta <= 0) return keepCurrent("NO_PROVEN_IMPROVEMENT");
if (input.p4Verdict === "BOUNDED") return review("MEDIUM", "BOUNDED_DIRECTIONAL_EVIDENCE");
return review(
  input.sampleSize >= MIN_SAMPLE_FOR_HIGH_CONFIDENCE ? "HIGH" : "MEDIUM",
  "EXACT_IMPROVEMENT_EVIDENCE",
);
```

Implement deterministic score weights fixed in source, totaling 100:

```text
lineage exact             25
P3 qualified/sample gate  20
P4 evidence tier          30  (EXACT=30, BOUNDED=20, UNAVAILABLE=0)
comparable delta present  15
no conflict               10
```

Score must not affect gate ordering; it is audit output only.

- [ ] **Step 5: Run evaluator GREEN test**

```bash
pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-recommendation-evaluator.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit schema/evaluator**

```bash
git add apps/api/src/contracts/phase7c-recommendation-intelligence.schema.ts apps/api/src/services/phase7c-recommendation-evaluator.service.ts scripts/phase7c-recommendation-evaluator.test.ts
git commit -m "feat(phase7c): add deterministic P5 recommendation evaluator"
```

---

### Task 3: P3/P4 Composition Service

**Files:**
- Create: `apps/api/src/services/phase7c-recommendation-intelligence.service.ts`
- Create: `scripts/phase7c-recommendation-intelligence.test.ts`

**Interfaces:**
- Consumes:
  - `getPhase7CPerformanceEffectivenessSnapshot(query)`
  - `getPhase7CCounterfactualIntelligence(query)`
  - `evaluatePhase7CRecommendationCandidate(input)`
- Produces:
  - `buildPhase7CRecommendationSnapshotFromEvidence(input)` for deterministic tests.
  - `getPhase7CRecommendationIntelligence(query)` for route use.

- [ ] **Step 1: Write composition RED tests**

Use synthetic P3/P4 snapshots and assert one candidate per canonical target key. Required examples:

```ts
// RULE: P3 observed rule exists, P4 RULE_OBSERVATION unavailable.
// Expected: COLLECT_MORE_EVIDENCE, reason COUNTERFACTUAL_RULE_REPLAY_UNAVAILABLE.

// ENTRY_TYPE: P3 entry aggregate exists and exact P2-derived rows exist, but no P4 entry replay family.
// Expected: COLLECT_MORE_EVIDENCE, reason COUNTERFACTUAL_ENTRY_REPLAY_UNAVAILABLE.

// MANAGEMENT: n=12 and P4 BOUNDED with explicit positive comparable delta.
// Expected: REVIEW_CHANGE, confidence MEDIUM, PnL/R null preserved.

// MANAGEMENT: multiple scenarios for the same target contain positive and negative comparable deltas.
// Expected: conflict=true and action != REVIEW_CHANGE.

// MANAGEMENT: evidence sufficient but average comparable delta <= 0.
// Expected: KEEP_CURRENT.
```

- [ ] **Step 2: Run composition test RED**

```bash
pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-recommendation-intelligence.test.ts
```

Expected: FAIL because composition service does not exist.

- [ ] **Step 3: Implement canonical candidate builders**

In `phase7c-recommendation-intelligence.service.ts`, build maps by target key:

```ts
function buildRuleCandidates(
  effectiveness: Phase7CPerformanceEffectivenessSnapshot,
  counterfactual: Phase7CCounterfactualSnapshot,
): Phase7CRecommendationCandidate[];

function buildEntryTypeCandidates(
  effectiveness: Phase7CPerformanceEffectivenessSnapshot,
  counterfactual: Phase7CCounterfactualSnapshot,
): Phase7CRecommendationCandidate[];

function buildManagementCandidates(
  effectiveness: Phase7CPerformanceEffectivenessSnapshot,
  counterfactual: Phase7CCounterfactualSnapshot,
): Phase7CRecommendationCandidate[];
```

Rules:
- `RULE`: target keys from `effectiveness.aggregates.rule`; match P4 `RULE_OBSERVATION` by `baseline.ruleId`; current P4 V1 unavailable replay maps to `COUNTERFACTUAL_RULE_REPLAY_UNAVAILABLE`.
- `ENTRY_TYPE`: target keys from `effectiveness.aggregates.entryType`; V1 has no P4 family, so candidate remains `COLLECT_MORE_EVIDENCE` with `COUNTERFACTUAL_ENTRY_REPLAY_UNAVAILABLE`; never compare expectancy causally.
- `MANAGEMENT`: target keys from `effectiveness.aggregates.management`; match P4 `MANAGEMENT_EXIT_POLICY` by `baseline.managementFamily` and relevant Fast-Move family when target is Fast-Move-related.
- Only finite explicit `delta.lockedProfitPrice` or `delta.exitPrice` values count as comparable deltas. Do not substitute P3 expectancy, PnL, or realized-R.
- Contradiction is true when a target has at least one positive and one negative explicit comparable delta in qualified P4 evidence.

- [ ] **Step 4: Build snapshot and summary**

Implement:

```ts
export interface Phase7CRecommendationEvidenceInput {
  effectiveness: Phase7CPerformanceEffectivenessSnapshot;
  counterfactual: Phase7CCounterfactualSnapshot;
  generatedAt?: number;
}

export function buildPhase7CRecommendationSnapshotFromEvidence(
  input: Phase7CRecommendationEvidenceInput,
): Phase7CRecommendationSnapshot;

export async function getPhase7CRecommendationIntelligence(
  query: { days?: number; symbol?: string; limit?: number } = {},
): Promise<Phase7CRecommendationSnapshot>;
```

Summary counts must include total candidates and each action count. Root safety uses `phase7CRecommendationSafety()`.

- [ ] **Step 5: Run composition GREEN test and API build**

```bash
pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-recommendation-intelligence.test.ts
pnpm --filter @xauusd/api... build
```

Expected: PASS.

- [ ] **Step 6: Commit composition service**

```bash
git add apps/api/src/services/phase7c-recommendation-intelligence.service.ts scripts/phase7c-recommendation-intelligence.test.ts
git commit -m "feat(phase7c): compose P5 recommendations from P3 and P4 evidence"
```

---

### Task 4: GET-only API Route

**Files:**
- Create: `apps/api/src/routes/phase7c-recommendation-intelligence.route.ts`
- Modify: `apps/api/src/app.ts`
- Test: `scripts/test-phase7c-recommendation-api-source.mjs`

**Interfaces:**
- Consumes: `getPhase7CRecommendationIntelligence({ days, symbol, limit })`.
- Produces: `GET /api/v1/phase7c/recommendation-intelligence` localhost-only JSON endpoint.

- [ ] **Step 1: Implement route using P4 query-validation pattern**

Create route equivalent to:

```ts
const router = Router();

router.get("/", async (req, res) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Recommendation intelligence is restricted to localhost." });
    return;
  }
  try {
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol : "XAUUSD";
    res.setHeader("cache-control", "no-store");
    res.json(await getPhase7CRecommendationIntelligence({
      days: readDays(req.query.days),
      symbol,
      limit: readLimit(req.query.limit),
    }));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error
        ? error.message
        : "Could not build Phase7C recommendation intelligence snapshot.",
    });
  }
});
```

Reuse the same bounds as P3/P4: `days 7..365`, `limit 1..200`.

- [ ] **Step 2: Mount router in `app.ts`**

Add:

```ts
import phase7cRecommendationIntelligenceRouter from "./routes/phase7c-recommendation-intelligence.route";
...
app.use("/api/v1/phase7c/recommendation-intelligence", phase7cRecommendationIntelligenceRouter);
```

No POST/PUT/PATCH/DELETE route is added.

- [ ] **Step 3: Run API source contract and build**

```bash
node scripts/test-phase7c-recommendation-api-source.mjs
pnpm --filter @xauusd/api... build
```

Expected: PASS.

- [ ] **Step 4: Commit API route**

```bash
git add apps/api/src/routes/phase7c-recommendation-intelligence.route.ts apps/api/src/app.ts scripts/test-phase7c-recommendation-api-source.mjs
git commit -m "feat(phase7c): expose GET-only P5 recommendation API"
```

---

### Task 5: Control Center Advisory Card

**Files:**
- Create: `apps/web/src/phase7c-recommendation-intelligence-types.ts`
- Create: `apps/web/src/phase7c-recommendation-intelligence-api.ts`
- Create: `apps/web/src/ui/Phase7CRecommendationIntelligenceCard.tsx`
- Modify: `apps/web/src/pages/Phase7CControlCenterShellPage.tsx`
- Test: `scripts/test-phase7c-recommendation-intelligence-source.mjs`

**Interfaces:**
- Consumes: GET P5 snapshot.
- Produces: collapsed P5 card after P4, before P1 runtime-source card.

- [ ] **Step 1: Mirror canonical types for browser**

Create browser types with the same action/confidence/safety/candidate/summary fields as the API schema. Do not add mutable form models or setting-edit types.

- [ ] **Step 2: Implement GET client**

Create:

```ts
export async function getPhase7CRecommendationIntelligence(
  days = 90,
  symbol = "XAUUSD",
  limit = 100,
): Promise<Phase7CRecommendationSnapshot> {
  const params = new URLSearchParams({ days: String(days), symbol, limit: String(limit) });
  const response = await fetch(
    `${API_BASE}/api/v1/phase7c/recommendation-intelligence?${params.toString()}`,
    { method: "GET", cache: "no-store", headers: { accept: "application/json" } },
  );
  // Parse JSON; throw on non-2xx exactly as P3/P4 clients do.
}
```

- [ ] **Step 3: Implement collapsed advisory card**

Card header must render:

```tsx
<Typography variant="h6">P5 · Recommendation Intelligence</Typography>
<Chip size="small" label="READ ONLY" variant="outlined" />
<Chip size="small" label="ADVISORY ONLY" variant="outlined" />
<Chip size="small" label="AUTO APPLY: DISABLED" variant="outlined" />
<Chip size="small" label="AUTO RETUNE: DISABLED" variant="outlined" />
```

Summary: candidates, review changes, keep current, need more evidence, unavailable.

Expanded candidate details: scope/key, sample, P3 observed metrics, P4 verdict, evidence score, confidence, action, reasons, limitations, and only proven deltas.

No mutation buttons.

- [ ] **Step 4: Implement stale-refetch distinction**

Use React Query state so:

```tsx
{query.isError && !snapshot ? (
  <Alert severity="warning">Không đọc được P5 recommendation intelligence...</Alert>
) : null}

{query.isError && snapshot ? (
  <Alert severity="warning">Không cập nhật được dữ liệu P5 mới; đang hiển thị snapshot gần nhất.</Alert>
) : null}
```

This prevents the misleading P3/P4-style total failure message when cached data still exists.

- [ ] **Step 5: Mount P5 after P4**

Modify shell:

```tsx
<Phase7CPerformanceEffectivenessCard />
<Phase7CCounterfactualIntelligenceCard />
<Phase7CRecommendationIntelligenceCard />
<Phase7CRuntimeSourceAttestationCard />
```

- [ ] **Step 6: Run source contract and Web build**

```bash
node scripts/test-phase7c-recommendation-intelligence-source.mjs
pnpm --filter @xauusd/web... build
```

Expected: PASS.

- [ ] **Step 7: Commit UI**

```bash
git add apps/web/src/phase7c-recommendation-intelligence-types.ts apps/web/src/phase7c-recommendation-intelligence-api.ts apps/web/src/ui/Phase7CRecommendationIntelligenceCard.tsx apps/web/src/pages/Phase7CControlCenterShellPage.tsx scripts/test-phase7c-recommendation-intelligence-source.mjs
git commit -m "feat(phase7c): add advisory P5 Control Center card"
```

---

### Task 6: Production Acceptance Verifier Source

**Files:**
- Create: `scripts/verify-phase7c-p5-production-acceptance-local.ps1`
- Create: `scripts/test-phase7c-p5-production-acceptance-source.ps1`

**Interfaces:**
- Consumes: exact production project root, expected commit, localhost GET endpoints.
- Produces: read-only acceptance markers only; no mutation.

- [ ] **Step 1: Write verifier source-contract RED test**

Require verifier literals and reject mutation verbs:

```powershell
$Verifier = Join-Path $ProjectRoot 'scripts\verify-phase7c-p5-production-acceptance-local.ps1'
if (-not (Test-Path -LiteralPath $Verifier)) { throw 'Missing P5 production acceptance verifier.' }
$text = Get-Content -LiteralPath $Verifier -Raw
foreach ($required in @(
  'P5_PRODUCTION_ACCEPTANCE',
  'phase7c-recommendation-intelligence-v1',
  'READ_ONLY',
  'ADVISORY_ONLY',
  'AUTO_APPLY',
  'AUTO_RETUNE',
  'runtime-source-attestation'
)) {
  if (-not $text.Contains($required)) { throw "Missing required verifier marker: $required" }
}
foreach ($forbidden in @('Invoke-RestMethod -Method Post','-Method Put','-Method Patch','-Method Delete','Start-ScheduledTask','Stop-ScheduledTask')) {
  if ($text -match [regex]::Escape($forbidden)) { throw "Forbidden mutation in verifier: $forbidden" }
}
```

- [ ] **Step 2: Implement GET-only verifier**

Verifier must:
1. prove clean `main@ExpectedCommit`;
2. GET runtime source attestation and require `overall=EXACT_MATCH` plus 8 components exact;
3. GET `/api/v1/phase7c/recommendation-intelligence?days=90&symbol=XAUUSD&limit=100`;
4. require schema version, root safety flags, candidate safety/advisory invariants, and deterministic action/confidence gates;
5. verify no candidate with P4 `BOUNDED` has `HIGH` confidence;
6. verify no `REVIEW_CHANGE` candidate has sample < 10;
7. verify `AUTO_APPLY=false`, `AUTO_RETUNE=false`;
8. print `ORDER_MUTATION=NONE`, `POSITION_MUTATION=NONE`, `MODE_CHANGE=NONE`, `ARM_CHANGE=NONE`, `LIVE_TEST_ORDER=NONE` and `P5_PRODUCTION_ACCEPTANCE=PASS` only on success.

- [ ] **Step 3: Run verifier source contract on PS7/PS5.1 where available**

```powershell
pwsh -NoProfile -File .\scripts\test-phase7c-p5-production-acceptance-source.ps1 -ProjectRoot $PWD
powershell.exe -NoProfile -File .\scripts\test-phase7c-p5-production-acceptance-source.ps1 -ProjectRoot $PWD
```

Expected: PASS after verifier exists.

- [ ] **Step 4: Commit verifier**

```bash
git add scripts/verify-phase7c-p5-production-acceptance-local.ps1 scripts/test-phase7c-p5-production-acceptance-source.ps1
git commit -m "test(phase7c): add P5 production acceptance verifier"
```

---

### Task 7: Dedicated P5 CI and Regressions

**Files:**
- Create: `.github/workflows/phase7c-recommendation-intelligence-ci.yml`

**Interfaces:**
- Consumes: all P5 tests/builds plus existing P2/P3/P4 scripts.
- Produces: one dedicated GitHub Actions gate `Phase7C Recommendation Intelligence CI`.

- [ ] **Step 1: Add workflow triggers for every P5 file plus spec/plan**

Use Node 24 and pnpm 10.18.0, matching P4 CI.

- [ ] **Step 2: Add Linux contract/build job**

Run in order:

```yaml
- run: pnpm install --frozen-lockfile
- run: node scripts/test-phase7c-recommendation-intelligence-source.mjs
- run: pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-recommendation-evaluator.test.ts
- run: pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-recommendation-intelligence.test.ts
- run: node scripts/test-phase7c-recommendation-api-source.mjs
- run: pnpm --filter @xauusd/api... build
- run: pnpm --filter @xauusd/web... build
- run: pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-counterfactual-evaluator.test.ts
- run: pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-counterfactual-intelligence.test.ts
```

Also run existing P3/P2 source/semantic scripts that are valid on Linux; do not duplicate full Canonical PR Gate.

- [ ] **Step 3: Add Windows production-verifier source job**

```yaml
- name: P5 production acceptance source contract with PowerShell 7
  shell: pwsh
  run: .\scripts\test-phase7c-p5-production-acceptance-source.ps1 -ProjectRoot $PWD

- name: P5 production acceptance source contract with Windows PowerShell 5.1
  shell: powershell
  run: .\scripts\test-phase7c-p5-production-acceptance-source.ps1 -ProjectRoot $PWD
```

- [ ] **Step 4: Run local-equivalent test suite**

```bash
node scripts/test-phase7c-recommendation-intelligence-source.mjs
node scripts/test-phase7c-recommendation-api-source.mjs
pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-recommendation-evaluator.test.ts
pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-recommendation-intelligence.test.ts
pnpm --filter @xauusd/api... build
pnpm --filter @xauusd/web... build
git diff --check
```

Expected: all PASS.

- [ ] **Step 5: Commit CI**

```bash
git add .github/workflows/phase7c-recommendation-intelligence-ci.yml
git commit -m "ci(phase7c): gate P5 recommendation intelligence"
```

---

### Task 8: Final Verification, PR, and Merge Gate

**Files:**
- No new production files expected.
- Review all branch changes against `main` and the approved spec.

**Interfaces:**
- Consumes: completed P5 branch.
- Produces: mergeable PR with exact-head CI evidence; no production rollout.

- [ ] **Step 1: Verify diff scope**

```bash
git diff --check main...HEAD
git diff --name-only main...HEAD
```

Expected changed files only in P5 schema/service/route/UI/tests/workflow/spec/plan and `app.ts`/Control Center shell composition.

- [ ] **Step 2: Run full targeted suite one final time**

```bash
node scripts/test-phase7c-recommendation-intelligence-source.mjs
node scripts/test-phase7c-recommendation-api-source.mjs
pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-recommendation-evaluator.test.ts
pnpm --filter @xauusd/api exec tsx ../../scripts/phase7c-recommendation-intelligence.test.ts
pnpm --filter @xauusd/api... build
pnpm --filter @xauusd/web... build
```

Expected: PASS.

- [ ] **Step 3: Open PR from exact branch head**

PR title:

```text
feat(phase7c): add P5 recommendation intelligence v1
```

PR body must record:
- approved V1 deterministic design;
- RED head/run evidence;
- GREEN exact head;
- dedicated P5 CI status;
- P2/P3/P4 regression status;
- Canonical PR Gate Windows/Linux status;
- safety invariants and no LIVE rollout.

- [ ] **Step 4: Require fresh exact-head CI before merge**

Do not merge until:
- `Phase7C Recommendation Intelligence CI` = SUCCESS;
- `Phase7C Canonical PR Gate` Windows + Linux = SUCCESS;
- directly impacted Web LIVE Arm / runtime-source / P3/P4 workflows, if triggered, = SUCCESS;
- PR head has not changed since those runs.

- [ ] **Step 5: Merge only exact verified head**

Use squash merge after all gates pass. Record new `main` SHA and post-merge Canonical Gate result.

- [ ] **Step 6: Stop before production rollout**

Final source checkpoint must state:

```text
P5_SOURCE=MERGED
P5_CI=GREEN
P5_PRODUCTION_ACCEPTANCE=NOT_YET_RUN
LIVE_RUNTIME_MUTATION=NONE
AUTO_APPLY=FALSE
AUTO_RETUNE=FALSE
```

Only after this checkpoint should a separate production source-transition/acceptance flow be prepared against the new merged main.
