# P5 Recommendation Intelligence V1 — Design

Date: 2026-09-05

## 1. Objective

P5 adds a deterministic, evidence-gated recommendation layer above the existing Phase7C observability stack:

- P1 Runtime Source Attestation proves the running source generation.
- P2 Decision → Trade → Outcome lineage proves explicit trade attribution.
- P3 Performance Effectiveness measures observed rule, entry, management, excursion, and Fast-Move effectiveness.
- P4 Shadow/Counterfactual Intelligence evaluates alternatives with explicit `EXACT | BOUNDED | UNAVAILABLE` evidence verdicts.
- P5 converts sufficiently strong P2/P3/P4 evidence into advisory recommendations without changing LIVE behavior.

P5 V1 is not an optimizer and is not an auto-retune mechanism. It is a read-only advisory subsystem.

## 2. Locked Safety Boundary

The following invariants are mandatory at schema, service, API, UI, tests, CI, and production acceptance layers:

```text
READ_ONLY=TRUE
ADVISORY_ONLY=TRUE
AUTO_APPLY=FALSE
AUTO_RETUNE=FALSE
STRATEGY_MUTATION=FALSE
RISK_MUTATION=FALSE
ORDER_MUTATION=FALSE
POSITION_MUTATION=FALSE
MODE_MUTATION=FALSE
ARM_MUTATION=FALSE
RUNTIME_RESTART=NONE
LIVE_TEST_ORDER=NONE
```

P5 must expose no API route, UI control, background task, callback, or hidden state transition that applies a recommendation to strategy/risk/runtime configuration.

Any later decision to implement an approved recommendation remains a separate human-reviewed strategy change with the normal source/CI/production rollout process.

## 3. Scope

P5 V1 evaluates recommendation candidates across three target scopes:

```text
RULE
ENTRY_TYPE
MANAGEMENT
```

P5 does not create independent counterfactual simulations. It only consumes canonical evidence already exposed by P2, P3, and P4.

Out of scope for V1:

- automatic parameter search;
- reinforcement learning;
- Bayesian or ML-based optimization;
- autonomous strategy/risk changes;
- position/order decisions;
- recommendation-driven AUTO/ARM changes;
- inferred missed-trade PnL;
- causal claims derived only from observational P3 aggregates;
- persistence that mutates executor/runtime state;
- per-regime or per-strategy sub-recommendation expansion.

V1 deliberately creates one candidate per canonical target key across the current query window. Regime/strategy are retained as supporting context when present in evidence, but V1 does not split the same target into many regime-specific recommendations. This avoids false precision with the current small sample size.

## 4. Canonical Schema

Schema version:

```text
phase7c-recommendation-intelligence-v1
```

The top-level snapshot must expose:

- `schemaVersion`
- `generatedAt`
- `source = PHASE7C_RECOMMENDATION_INTELLIGENCE`
- `readOnly = true`
- `advisoryOnly = true`
- immutable safety flags
- summary counts
- recommendation candidates
- notes explaining evidence limitations

Each candidate must identify:

- stable `recommendationId`
- `targetScope`: `RULE | ENTRY_TYPE | MANAGEMENT`
- target key/id
- observed strategy/regime context when available
- sample size
- P2 lineage evidence summary
- P3 observed-effectiveness summary
- P4 counterfactual evidence summary
- deterministic evidence score
- recommendation action
- confidence
- reason codes
- limitations
- optional measurable deltas only when explicitly proved

Stable candidate ids use the deterministic form:

```text
RULE:<ruleId>
ENTRY_TYPE:<entryType>
MANAGEMENT:<managementFamily>
```

after trimming target keys. Empty keys are discarded rather than converted into candidates.

## 5. Candidate Construction

### RULE

Create one candidate for each distinct non-empty P3 rule aggregate key. Attach all P4 `RULE_OBSERVATION` scenarios whose `baseline.ruleId` matches the same key exactly.

### ENTRY_TYPE

Create one candidate for each distinct P3 entry-type aggregate key. P4 V1 has no canonical ENTRY_TYPE replay family, so the P4 evidence tier for these candidates is `UNAVAILABLE` with explicit reason `COUNTERFACTUAL_ENTRY_REPLAY_UNAVAILABLE`.

### MANAGEMENT

Create one candidate for each distinct non-empty P3 management aggregate key. Attach all P4 `MANAGEMENT_EXIT_POLICY` scenarios whose `baseline.managementFamily` matches the same key exactly.

P5 does not perform fuzzy matching across rule names, entry types, or management families.

Candidate `sampleSize` is the matching P3 aggregate sample size. P2 exact-lineage quality is inherited through the P3 rows/quality flags that P3 already derived from canonical P2 correlation; P5 does not reread journal/accounting data or create a second P2 correlation implementation.

## 6. Recommendation Actions

Allowed actions:

```text
KEEP_CURRENT
REVIEW_CHANGE
COLLECT_MORE_EVIDENCE
UNAVAILABLE
```

Semantics:

### KEEP_CURRENT

Evidence is sufficient to evaluate the target but does not prove an alternative is better than the current behavior.

### REVIEW_CHANGE

Evidence supports human review of a change. This never means apply automatically.

### COLLECT_MORE_EVIDENCE

A plausible candidate exists but evidence quantity or quality is insufficient to make a change recommendation.

### UNAVAILABLE

Canonical evidence needed to evaluate the candidate is missing, contradictory beyond safe comparison, or structurally unsupported.

## 7. Confidence Model

Allowed confidence values:

```text
HIGH
MEDIUM
LOW
NONE
```

Confidence is deterministic and evidence-based, not a probability estimate.

Rules:

- `BOUNDED` evidence can never produce `HIGH` confidence.
- `UNAVAILABLE` evidence produces `NONE` confidence when the candidate cannot be meaningfully evaluated.
- `COLLECT_MORE_EVIDENCE` produces `LOW` when a valid observed candidate exists and `NONE` when even observed qualification is unavailable.
- `HIGH` requires `EXACT` P4 evidence plus the higher sample threshold and no contradiction gate.
- `KEEP_CURRENT` may be `MEDIUM` or `HIGH` under the same evidence-tier/sample constraints; confidence describes evidence quality, not direction of change.

## 8. Deterministic Evidence Gates

Initial V1 thresholds:

```text
MIN_SAMPLE_FOR_REVIEW=10
MIN_SAMPLE_FOR_HIGH_CONFIDENCE=30
```

These thresholds are source constants in V1 and are not runtime-tunable from Control Center.

### Gate order

P5 evaluates every candidate in fail-closed order:

1. Identity / lineage gate
2. Observed effectiveness gate
3. Counterfactual evidence gate
4. Sample-size gate
5. Comparable-delta gate
6. Contradiction gate
7. Recommendation action
8. Confidence cap

### P2 identity / lineage gate

Only evidence derived from exact explicit identity lineage may contribute to a change recommendation.

`AMBIGUOUS` or `UNMATCHED` lineage must not be converted into causal or profitability attribution.

P5 proves this through P3 exact-correlation quality. If the candidate cannot be tied to exact P3 evidence, it is not eligible for `REVIEW_CHANGE`.

### P3 effectiveness gate

P3 may identify an observed candidate or provide sample statistics, but P3 alone must not generate `REVIEW_CHANGE` for RULE or ENTRY_TYPE because observational differences are not causal proof.

### P4 counterfactual gate

P4 evidence verdict handling:

```text
EXACT       -> eligible for full deterministic evaluation
BOUNDED     -> eligible only for controlled REVIEW semantics
UNAVAILABLE -> not eligible for REVIEW_CHANGE
```

For a candidate with multiple attached P4 scenarios, its effective P4 tier is fail-closed:

```text
EXACT     only if at least one comparable EXACT scenario exists and no comparable BOUNDED/EXACT scenario conflicts in direction
BOUNDED   if no qualifying EXACT tier exists but at least one comparable BOUNDED scenario exists and no comparable scenario conflicts in direction
UNAVAILABLE otherwise
```

Uncomparable scenarios with all supported delta fields null do not establish direction and therefore do not upgrade the tier.

### Comparable directional evidence

A P4 scenario is directionally comparable only when at least one explicit supported delta field is finite:

```text
delta.realizedR
delta.netPnl
delta.exitPrice
delta.lockedProfitPrice
```

Priority for direction is:

```text
realizedR -> netPnl -> lockedProfitPrice -> exitPrice
```

The first finite field in that order determines the scenario direction. P5 never substitutes P3 values for a missing P4 delta.

Direction is:

```text
positive -> improvement
zero     -> neutral
negative -> deterioration
```

### Contradiction gate

A candidate has `EVIDENCE_CONFLICT` when its comparable attached P4 scenarios contain both positive and negative directions after applying the priority rule above.

Neutral scenarios do not conflict with positive or negative scenarios.

A conflict blocks `REVIEW_CHANGE` and yields `COLLECT_MORE_EVIDENCE` when the observed candidate remains valid. If evidence structure itself is malformed/unusable, the action is `UNAVAILABLE`.

### BOUNDED restrictions

A `BOUNDED` candidate may support `REVIEW_CHANGE` only when all are true:

- sample size >= 10;
- explicit comparable directional evidence exists;
- all comparable non-neutral directions are positive;
- no contradiction gate fires;
- the recommendation does not claim unproved counterfactual PnL or realized-R;
- confidence is capped at `MEDIUM`.

If P4 leaves exit/PnL/R null, P5 must preserve those fields as null and must not infer them from P3.

### EXACT restrictions

An `EXACT` candidate may support `REVIEW_CHANGE` only when:

- sample size >= 10;
- at least one comparable EXACT scenario is positive;
- no comparable scenario is negative;
- no contradiction or material data-quality gate fires.

`HIGH` confidence additionally requires:

- sample size >= 30;
- effective P4 tier `EXACT`;
- no evidence conflict;
- no material quality warning affecting comparability.

### Insufficient evidence

```text
sample < 10
-> COLLECT_MORE_EVIDENCE

P4=UNAVAILABLE with a valid observed candidate
-> COLLECT_MORE_EVIDENCE

no explicit comparable delta
-> COLLECT_MORE_EVIDENCE
```

Use `UNAVAILABLE` rather than `COLLECT_MORE_EVIDENCE` only when canonical data needed even to define/evaluate the target is absent, malformed, or structurally unsupported.

### Keep-current rule

When sample/evidence qualification is sufficient and comparable evidence is neutral or deterioration-only, with no contradiction:

```text
KEEP_CURRENT
```

P5 must not manufacture a change recommendation merely because a candidate exists.

## 9. Deterministic Evidence Score

P5 V1 exposes integer `evidenceScore` from 0 to 100.

The score is an auditability metric, not a probability and not an expected return.

The schema and UI must make this explicit:

```text
EVIDENCE_SCORE_IS_NOT_PROBABILITY=TRUE
```

Exact V1 scoring is fixed in source:

```text
P2 exact-lineage qualification                         25 points
P3 sample qualification                               0..25 points
P4 effective evidence tier                            0..35 points
Explicit comparable directional delta                 10 points
No evidence conflict / material comparability warning  5 points
TOTAL                                                0..100
```

P3 sample points use:

```text
round(min(sampleSize, 30) / 30 * 25)
```

P4 tier points:

```text
EXACT       35
BOUNDED     20
UNAVAILABLE  0
```

Comparable delta points are 10 only when at least one attached scenario is directionally comparable; otherwise 0.

Consistency points are 5 only when there is no `EVIDENCE_CONFLICT` and no material comparability warning; otherwise 0.

P2 points are 25 only when the candidate's contributing P3 evidence is exact-lineage qualified; otherwise 0.

Evidence score never overrides a fail-closed action gate. A high numeric score cannot turn `UNAVAILABLE` or conflicting evidence into `REVIEW_CHANGE`.

## 10. RULE Recommendations

RULE candidates originate from P3 rule aggregates and matching P4 `RULE_OBSERVATION` scenarios.

P3 may describe observed differences, but P5 must not recommend disabling/enabling a rule based only on observed expectancy or win rate.

Current P4 V1 behavior marks `RULE_OBSERVATION` as `UNAVAILABLE` unless canonical rule-replay evidence exists. Therefore P5 must normally return:

```text
COLLECT_MORE_EVIDENCE
reason=COUNTERFACTUAL_RULE_REPLAY_UNAVAILABLE
```

or `UNAVAILABLE` when the target cannot be evaluated at all.

P5 must not invent missed-trade PnL or alternate rule outcomes.

## 11. ENTRY_TYPE Recommendations

ENTRY_TYPE candidates use P3 entry-type effectiveness plus exact lineage inherited from P2 through P3.

Example observed data may show different expectancy for IMMEDIATE vs PULLBACK, but P5 must not conclude that one should be removed or preferred without matching counterfactual evidence.

Because P4 V1 has no canonical ENTRY_TYPE replay family, V1 surfaces entry candidates as evidence-collection recommendations rather than causal change recommendations.

Expected behavior for a valid observed entry candidate:

```text
targetScope=ENTRY_TYPE
recommendation=COLLECT_MORE_EVIDENCE
confidence=LOW
reason=COUNTERFACTUAL_ENTRY_REPLAY_UNAVAILABLE
```

## 12. MANAGEMENT Recommendations

MANAGEMENT candidates combine P3 management aggregates with matching P4 `MANAGEMENT_EXIT_POLICY` scenarios.

P4 `BOUNDED` management evidence may support a review recommendation only when explicit directional evidence is present and all BOUNDED restrictions are satisfied.

If P4 cannot prove counterfactual exit/PnL/R, P5 may state observed P3 management metrics and a proved bounded directional result, but unproved metrics remain null.

Fast-Move remains represented through canonical P4 evidence and the current `10/10` baseline. P5 must not directly alter the Fast-Move contract.

## 13. Reason Codes

Reason codes must be explicit and machine-testable. Initial V1 reason set:

```text
EXACT_LINEAGE_REQUIRED
INSUFFICIENT_SAMPLE
COUNTERFACTUAL_UNAVAILABLE
COUNTERFACTUAL_RULE_REPLAY_UNAVAILABLE
COUNTERFACTUAL_ENTRY_REPLAY_UNAVAILABLE
BOUNDED_DIRECTIONAL_EVIDENCE
EXACT_IMPROVEMENT_EVIDENCE
NO_PROVEN_IMPROVEMENT
EVIDENCE_CONFLICT
MISSING_COMPARABLE_DELTA
PNL_NOT_PROVABLE
REALIZED_R_NOT_PROVABLE
HIGH_CONFIDENCE_SAMPLE_NOT_MET
MATERIAL_COMPARABILITY_WARNING
```

The implementation may add narrowly scoped reason codes during TDD only when they refine diagnostics without weakening the evidence gates.

## 14. API

P5 exposes one GET-only localhost API:

```http
GET /api/v1/phase7c/recommendation-intelligence
```

Query shape follows the existing P3/P4 read-only pattern:

```text
days=90
symbol=XAUUSD
limit=100
```

Response requirements:

- `cache-control: no-store`
- no state mutation
- no persistence into executor/runtime state
- no non-GET sibling route for apply/retune/save

Explicitly forbidden routes/actions include:

```text
POST apply
POST retune
PUT settings
PATCH strategy
```

## 15. Control Center UI

Add a collapsed-by-default card after P4:

```text
P5 · Recommendation Intelligence
READ ONLY
ADVISORY ONLY
AUTO APPLY: DISABLED
AUTO RETUNE: DISABLED
```

Collapsed summary:

- candidate count
- `REVIEW_CHANGE` count
- `KEEP_CURRENT` count
- `COLLECT_MORE_EVIDENCE` count
- `UNAVAILABLE` count

Expanded details per candidate:

- target scope / target key
- strategy/regime supporting context if available
- sample size
- P3 observed metrics
- P4 evidence tier
- evidence score
- explicit `not a probability` label
- confidence
- recommendation action
- reason codes
- evidence limitations
- explicit delta metrics only when proved

The card must contain no apply/save/retune/accept-and-apply controls.

If a background refetch fails while a previous snapshot exists, UI must show the last known snapshot with a stale/refetch warning. It must reserve the total-read-error state for cases where no snapshot is available.

## 16. Data Flow

Canonical data flow:

```text
P2 correlation
      ↓
P3 performance effectiveness
      ↓
P4 counterfactual intelligence
      ↓
P5 recommendation evaluator
      ↓
P5 recommendation service
      ↓
GET-only route
      ↓
Control Center card
```

At runtime, P5 calls canonical P3/P4 services and uses P3's inherited exact-correlation evidence rather than independently reading P2 decision/deal files. P4 already derives from P3. This avoids duplicate raw-data reads and prevents P5 from creating a second attribution/replay implementation.

P5 may fetch P3 and P4 snapshots within the same request, but they must use the same normalized query (`days`, `symbol`, `limit`). Candidate evaluation must fail closed if the snapshots are structurally incompatible.

## 17. Error Handling and Fail-Closed Semantics

P5 fails closed at the recommendation level.

Examples:

- malformed or unavailable P4 evidence -> candidate `UNAVAILABLE` or `COLLECT_MORE_EVIDENCE` according to the structural rule above;
- insufficient sample -> `COLLECT_MORE_EVIDENCE`;
- contradictory comparable evidence -> `COLLECT_MORE_EVIDENCE`, never `REVIEW_CHANGE`;
- absent unproved metrics -> preserve null;
- service read failure -> GET returns an explicit error and UI preserves runtime safety messaging;
- stale UI data after refetch failure -> display last known snapshot with stale/refetch warning.

No error path may trigger runtime mutation or substitute guessed values.

## 18. TDD Strategy

Implementation must be RED-first.

Required RED coverage before production implementation:

1. missing P5 schema/service/API/UI source contract;
2. BOUNDED evidence incorrectly allowed HIGH confidence;
3. P3 observational difference incorrectly creating `REVIEW_CHANGE` without P4 support;
4. sample < 10 incorrectly creating `REVIEW_CHANGE`;
5. null P4 PnL/R incorrectly inferred from P3;
6. unavailable rule/entry replay incorrectly treated as causal evidence;
7. positive/negative evidence conflict incorrectly producing a change recommendation;
8. evidence score incorrectly overriding a fail-closed gate;
9. forbidden apply/retune controls or mutation routes;
10. refetch failure with cached P5 data incorrectly shown as total read failure.

GREEN verification must cover:

- deterministic evaluator semantics;
- exact score weights and thresholds;
- schema safety invariants;
- GET-only API and `cache-control: no-store`;
- Web rendering and no mutation controls;
- stale/refetch UI semantics;
- P2/P3/P4 regressions;
- API/Web build;
- canonical Windows/Linux gate;
- diff hygiene.

## 19. CI

Add a dedicated workflow:

```text
Phase7C Recommendation Intelligence CI
```

It includes:

- P5 source contract;
- recommendation semantic tests;
- API source/API behavior tests;
- Web source contract;
- API build;
- Web build;
- relevant P2/P3/P4 regressions;
- diff hygiene.

Final PR merge remains gated on the dedicated P5 workflow plus Canonical PR Gate and other directly impacted Phase7C workflows.

## 20. Production Acceptance

Production rollout remains separate from source/CI implementation.

P5 production acceptance must prove at minimum:

- production checkout exactly matches the accepted merged main commit;
- runtime source attestation is 8/8 EXACT;
- P5 GET endpoint returns `phase7c-recommendation-intelligence-v1`;
- root and candidate safety flags are read-only/advisory-only;
- no auto-apply/auto-retune capability exists;
- recommendation semantics obey sample/evidence/confidence gates;
- evidence score is labeled non-probabilistic and cannot override gates;
- no order/position/mode/ARM mutation;
- no LIVE test order.

Production acceptance must not be inferred from CI alone.

## 21. Expected Initial LIVE Behavior

Given the dataset observed around the design checkpoint:

```text
P3 exact trades ≈ 13
P4 EXACT=0
P4 BOUNDED=8
P4 UNAVAILABLE=92
```

P5 V1 is expected to produce many `COLLECT_MORE_EVIDENCE` / `UNAVAILABLE` recommendations and few or no strong change recommendations.

That is correct fail-closed behavior. P5 must prefer insufficient-evidence output over fabricated certainty.

## 22. Delivery Sequence

```text
P5.1  Canonical schema + safety contract
P5.2  RED semantic/source tests
P5.3  Deterministic recommendation evaluator
P5.4  P3/P4 composition service
P5.5  GET-only API
P5.6  Control Center card
P5.7  Dedicated CI + P2/P3/P4 regressions
P5.8  PR + Canonical Gate + merge
P5.9  Separate production acceptance
```

No LIVE deployment is part of the source implementation phase.
