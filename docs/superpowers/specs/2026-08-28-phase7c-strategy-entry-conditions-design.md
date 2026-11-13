# Phase 7C Strategy Entry Conditions — Design

Date: 2026-08-28
Status: Approved design, pre-implementation
Scope: Trend and Sideway NEW ENTRY condition configurability only

## 1. Goal

Add one canonical, operator-controlled strategy-entry profile for Phase 7C Trend and Sideway so Web Control Center can enable or disable approved strategic entry conditions without changing internal indicator parameters, restarting executors, weakening mandatory safety gates, or changing existing position management.

This feature changes NEW ENTRY gating only. It must not alter HOLD, break-even at +6, one-third partial close at +10, structural trailing, TP2, Recovery TP, exit logic, lot/risk rules, account safety, LIVE ARM, AUTO/PAUSE semantics, or lifecycle-broker behavior.

## 2. Approved product decisions

- **A1:** Each bot must have at least one strategic entry condition enabled. Zero enabled conditions for either bot is invalid and cannot be saved.
- **B2:** Trend and Sideway each use one shared condition profile across DEMO and LIVE. There are no account-specific profiles.
- **C1:** Configuration may be changed and saved only while `BOT_MODE=PAUSE` and `XAUUSD_POSITIONS=0`. A saved profile applies from the next NEW ENTRY evaluation cycle and requires no executor restart.
- **D1:** All enabled strategic conditions for a bot use logical AND. Every enabled condition must PASS before the strategy gate passes. Disabled conditions are ignored for gating.
- **E1:** Initial/default configuration preserves current behavior exactly. Deploying the feature alone must not make either bot looser or stricter.
- **F1:** Web may only enable/disable approved conditions. Internal thresholds and parameters remain canonical and are not editable through this feature.
- **G1:** Sideway must always retain one directional anchor. `rangeEdge` is the canonical Sideway BUY/SELL source, is permanently enabled, is not user-toggleable, and any API payload with `rangeEdge=false` is invalid. `m5Confirmation` remains toggleable and, when enabled, only confirms the side already selected by `rangeEdge`.
- **G2a:** Trend must always retain one directional anchor. `patternM15` is the canonical Trend BUY/SELL source, is permanently enabled, is not user-toggleable, and any API payload with `patternM15=false` is invalid. Other approved Trend conditions remain toggleable.

## 3. Architecture

Use one canonical persisted state file owned by the API configuration service and consumed read-only by both executors:

`.runtime/phase7c-strategy-entry-conditions.json`

The file is shared across DEMO and LIVE and contains a monotonic configuration version, audit metadata, Trend condition state, and Sideway condition state.

The API is the only write authority. Writes are whole-state replacements, validated against a fixed whitelist, guarded by runtime preconditions, protected by optimistic concurrency, and persisted atomically through a temporary file followed by rename.

Trend and Sideway must use one shared strategy-condition loader/evaluator so PASS/FAIL/IGNORED semantics, version handling, and mandatory-anchor validation cannot drift.

## 4. Canonical state schema

```json
{
  "version": 7,
  "updatedAt": "2026-08-28T00:00:00.000Z",
  "updatedBy": "web-control-center",
  "trend": {
    "patternM15": true,
    "supertrendM15": true,
    "supertrendM5": true,
    "validTrendStructure": true,
    "ma20Ma50": false,
    "fvg": false
  },
  "sideway": {
    "rangingRegime": true,
    "recommendedModeSideway": true,
    "minimumRegimeConfidence": true,
    "supplyDemandRange": true,
    "rangeEdge": true,
    "m5Confirmation": true
  }
}
```

Rules:

- successful persisted changes increment `version` by exactly one;
- `updatedAt` and `updatedBy` are audit metadata only;
- unknown keys, missing required keys, or non-boolean condition values are invalid;
- zero enabled conditions for either bot is invalid;
- `trend.patternM15` must always be `true`;
- `sideway.rangeEdge` must always be `true`.

## 5. Default profile and migration behavior

If the canonical file has never existed, the service exposes a virtual safe default with:

- `version = 0`
- `updatedAt = 1970-01-01T00:00:00.000Z`
- `updatedBy = safe-default`

The first successful save must submit `expectedVersion=0` and persist version `1`.

Default Trend:

- `patternM15 = true` — mandatory directional anchor
- `supertrendM15 = true`
- `supertrendM5 = true`
- `validTrendStructure = true`
- `ma20Ma50 = false`
- `fvg = false`

Default Sideway:

- `rangingRegime = true`
- `recommendedModeSideway = true`
- `minimumRegimeConfidence = true`
- `supplyDemandRange = true`
- `rangeEdge = true` — mandatory directional anchor
- `m5Confirmation = true`

The no-file state is a compatibility state, not an error.

If a canonical file exists but is corrupt, incomplete, contains unknown keys, violates A1, sets `patternM15=false`, or sets `rangeEdge=false`, the service must fail closed. It must not silently fall back to defaults. In this scope, malformed persisted state is not repaired through normal Web POST; GET exposes `valid=false`, `editable=false`, and NEW ENTRY remains blocked until explicit operational repair.

## 6. Trend condition catalog

### Mandatory directional anchor

1. `patternM15` — existing M15 candlestick-pattern detector. It determines canonical BUY/SELL side and cannot be disabled.

### Toggleable confirmations

2. `supertrendM15` — existing canonical M15 Supertrend confirmation.
3. `supertrendM5` — existing canonical M5 Supertrend confirmation.
4. `validTrendStructure` — existing valid trend-structure gate.
5. `ma20Ma50` — existing MA20/MA50 observation promoted to an optional entry gate only when enabled.
6. `fvg` — existing FVG observation promoted to an optional entry gate only when enabled.

Supertrend parameters, MA periods, pattern definitions, FVG definitions, and structure-detection parameters are not editable here.

For all toggleable Trend confirmations that carry direction, PASS requires agreement with the `patternM15` side. A contradictory enabled confirmation is FAIL, not an alternative side selector.

## 7. Sideway condition catalog

### Mandatory directional anchor

1. `rangeEdge` — existing `chooseRangeSide(...)` location logic. It determines canonical BUY/SELL side from the valid Supply/Demand range and current bid/ask. It cannot be disabled.

### Toggleable conditions

2. `rangingRegime` — regime must be `RANGING` when enabled.
3. `recommendedModeSideway` — recommended mode must be `SIDEWAY` when enabled as a strategy observation; mandatory orchestration/mode permission remains separately enforced and cannot be disabled.
4. `minimumRegimeConfidence` — canonical regime-confidence threshold must pass when enabled.
5. `supplyDemandRange` — canonical Supply/Demand range validity/availability is an explicit strategic gate when enabled.
6. `m5Confirmation` — existing M5 confirmation must pass for the side already chosen by `rangeEdge` when enabled.

All six values remain present in the canonical state, but `rangeEdge` is locked `true` and is not operator-toggleable.

If `supplyDemandRange` is disabled, the executor may ignore that explicit gate, but the data structure required by mandatory `rangeEdge` is still a computational prerequisite. If no usable range exists, `rangeEdge` cannot determine a side and therefore fails closed.

The confidence threshold, range-construction rules, range-edge rules, and M5 confirmation parameters remain canonical and non-editable.

## 8. Condition status semantics

Every condition is normalized to exactly one of:

- `PASS` — enabled and canonical observation passes;
- `FAIL` — enabled and canonical observation fails;
- `IGNORED` — operator-toggleable condition is disabled and does not participate in the AND gate.

`IGNORED` must never be represented as `PASS`.

Mandatory anchors are always enabled and therefore can only be PASS or FAIL.

Where an observation remains available for a disabled condition, retain the observed value for audit/telemetry while reporting `IGNORED`.

For each bot:

`STRATEGY_GATE_PASS = every enabled condition has status PASS`

Because the mandatory directional anchor is always enabled, both bots always retain a defined direction source and never evaluate an empty AND set.

## 9. Mandatory non-toggleable safety/orchestration gates

This feature must never expose switches that disable or bypass any mandatory safety/orchestration logic, including at minimum:

- account-state validity and account guard;
- Bridge health/connectivity and account-mode match;
- MT5 terminal/expert/trading permission checks;
- active mode / PAUSE / AUTO orchestration;
- LIVE ARM authorization;
- data/quote freshness;
- spread protection;
- lot/risk validation and final auto-lot validation;
- duplicate/open-position protection;
- final pre-order safety recheck;
- lifecycle-broker safety.

A strategy gate passing is necessary but never sufficient to send an order.

`recommendedModeSideway` may be exposed as a strategic checkbox for observability/composition, but the canonical mode-routing permission used to prevent competing bot execution remains mandatory and outside the editable profile.

## 10. API contract

Expose:

- `GET /api/v1/phase7c/strategy-entry-conditions`
- `POST /api/v1/phase7c/strategy-entry-conditions`

### GET

GET is read-only and returns the canonical or virtual state plus validity, editability, NEW ENTRY scope, shared-account scope, and runtime save guards.

Example:

```json
{
  "state": {
    "version": 7,
    "updatedAt": "2026-08-28T00:00:00.000Z",
    "updatedBy": "web-control-center",
    "trend": {
      "patternM15": true,
      "supertrendM15": true,
      "supertrendM5": false,
      "validTrendStructure": true,
      "ma20Ma50": false,
      "fvg": true
    },
    "sideway": {
      "rangingRegime": true,
      "recommendedModeSideway": true,
      "minimumRegimeConfidence": true,
      "supplyDemandRange": true,
      "rangeEdge": true,
      "m5Confirmation": false
    }
  },
  "valid": true,
  "editable": true,
  "appliesTo": "NEW_ENTRIES_ONLY",
  "sharedAcrossAccounts": true,
  "mandatory": {
    "trend": ["patternM15"],
    "sideway": ["rangeEdge"]
  },
  "safety": {
    "requiresPause": true,
    "requiresZeroXauusdPositions": true
  }
}
```

The virtual no-file default returns the same shape with `version=0`. Invalid persisted state returns `valid=false`, `editable=false`, and NEW ENTRY fails closed.

### POST

POST accepts the complete Trend and Sideway state plus optimistic concurrency metadata:

```json
{
  "expectedVersion": 7,
  "trend": {
    "patternM15": true,
    "supertrendM15": true,
    "supertrendM5": false,
    "validTrendStructure": true,
    "ma20Ma50": false,
    "fvg": true
  },
  "sideway": {
    "rangingRegime": true,
    "recommendedModeSideway": true,
    "minimumRegimeConfidence": true,
    "supplyDemandRange": true,
    "rangeEdge": true,
    "m5Confirmation": false
  },
  "source": "web-control-center"
}
```

POST rejects partial patches. `source` is restricted to repository-approved operator sources; Web uses `web-control-center`.

A successful write increments `version` exactly once and returns the new canonical state.

If current version differs from `expectedVersion`, return HTTP 409 with `CONFIG_VERSION_CONFLICT` and perform no write.

If `patternM15=false` or `rangeEdge=false`, reject the request and perform no write.

## 11. POST safety and validation preconditions

A write is accepted only when all are true:

- account state is valid;
- BOT_MODE is exactly `PAUSE`;
- XAUUSD position count is exactly zero;
- Bridge telemetry required to prove those preconditions is available and valid;
- current persisted state is absent/virtual-default or valid;
- payload is complete and contains only canonical keys;
- all condition values are booleans;
- Trend enabled count is at least one;
- Sideway enabled count is at least one;
- `patternM15 === true`;
- `rangeEdge === true`;
- `expectedVersion` matches current canonical version.

A failed precondition performs no write and no version increment.

Runtime-precondition conflicts use HTTP 409. Malformed/schema-invalid payloads use the repository's existing validation-error convention, while always failing closed and preserving persisted state.

## 12. Atomic persistence and concurrency

Write to a temporary file in the same directory and rename over the canonical file, following the repository's existing canonical-settings pattern.

Executors must never observe partially written state.

Optimistic concurrency via `expectedVersion` prevents stale Web tabs or concurrent clients from overwriting newer operator choices.

## 13. Executor read and application model

No executor restart is required.

At the beginning of every NEW ENTRY evaluation cycle, each executor reads one immutable validated snapshot and records `cycleConfigVersion`.

Flow:

1. Read and validate canonical snapshot V.
2. Resolve the mandatory directional anchor first:
   - Trend: `patternM15` determines BUY/SELL;
   - Sideway: `rangeEdge` determines BUY/SELL.
3. If the mandatory anchor fails to produce a valid side, block entry.
4. Compute remaining canonical strategic observations against that side.
5. Normalize each condition to PASS, FAIL, or IGNORED.
6. Apply D1 AND semantics over all enabled conditions.
7. If strategy gate fails, block entry and audit failed condition IDs.
8. If strategy gate passes, continue through mandatory safety/orchestration gates.
9. Immediately before any order mutation, re-read strategy config.
10. If current config is invalid or version differs from V, block order mutation. Version mismatch uses `ENTRY_CONFIG_VERSION_CHANGED`.
11. If version is unchanged and all mandatory safety gates pass, existing order execution may proceed.

The executor must not re-read individual toggles mid-cycle.

## 14. Direction consistency contract

### Trend

`patternM15` is the only strategy-profile source allowed to originate side. Enabled Supertrend/MA/FVG/structure conditions may confirm or reject that side; they do not independently create an alternative trade side within this feature.

### Sideway

`rangeEdge` is the only strategy-profile source allowed to originate side. `m5Confirmation`, when enabled, evaluates only against that selected side. It does not independently infer or replace side.

Any enabled directional confirmation that contradicts the anchor side is FAIL.

## 15. Race-condition behavior

A configuration change after a cycle starts must never result in order submission using mixed versions.

Example:

- cycle starts with version 7;
- strategic observations pass under version 7;
- operator saves version 8 before order submission;
- final pre-order check sees `8 != 7`;
- order send is blocked;
- audit reason is `ENTRY_CONFIG_VERSION_CHANGED`;
- next cycle evaluates entirely under version 8.

No stale-signal retry is allowed.

## 16. Audit and reason codes

Extend canonical decision observability rather than creating a parallel audit channel.

Add:

- `ENTRY_STRATEGY_CONDITION_BLOCK`
- `ENTRY_STRATEGY_CONDITIONS_PASS`
- `ENTRY_CONFIG_VERSION_CHANGED`
- `ENTRY_STRATEGY_CONFIG_INVALID`

Decision records add `entryConditions`, for example:

```json
{
  "entryConditions": {
    "configVersion": 8,
    "side": "BUY",
    "anchorCondition": "patternM15",
    "enabledCount": 4,
    "allEnabledPassed": false,
    "conditions": [
      {
        "id": "patternM15",
        "enabled": true,
        "mandatory": true,
        "status": "PASS",
        "observed": "BULLISH_ENGULF"
      },
      {
        "id": "supertrendM5",
        "enabled": false,
        "mandatory": false,
        "status": "IGNORED",
        "observed": "SELL"
      },
      {
        "id": "fvg",
        "enabled": true,
        "mandatory": false,
        "status": "FAIL",
        "observed": "NONE"
      }
    ]
  }
}
```

When enabled conditions fail, `ENTRY_STRATEGY_CONDITION_BLOCK` identifies the failed IDs.

`ENTRY_STRATEGY_CONDITIONS_PASS` is observability only, not permission to trade. If a later mandatory safety gate fails, the final blocked reason remains the applicable safety reason.

## 17. Web Control Center design

Add a distinct `Điều kiện vào lệnh` section in Control Center, separate from `Tài khoản & Rủi ro`.

Use Trend and Sideway groups/tabs.

Each row shows:

- canonical Vietnamese label;
- checkbox/toggle state where editable;
- locked mandatory state for `patternM15` and `rangeEdge`;
- runtime PASS / FAIL / IGNORED when available;
- optional observed value.

Mandatory rows display as checked and locked, with copy such as `Bắt buộc · xác định hướng BUY/SELL`.

The editor is enabled only under C1. Otherwise all editable controls remain visible but disabled with a clear explanation that saving requires PAUSE and zero XAUUSD positions.

Validation:

- Save is disabled if a draft violates A1;
- mandatory anchors cannot be unchecked in UI;
- the client still submits the complete state with both mandatory values `true`;
- API remains authoritative and rejects any crafted request setting either anchor to `false`.

Buttons:

- `Khôi phục` — discard unsaved draft and reload canonical saved state;
- `Khôi phục mặc định chiến lược` — reset draft to E1 defaults only;
- `Lưu cấu hình` — submit complete state plus `expectedVersion`.

No internal thresholds or indicator parameters are exposed.

## 18. Web stale-version behavior

If POST returns `CONFIG_VERSION_CONFLICT`, Web must not silently retry. Reload latest canonical state, inform the operator that configuration changed elsewhere, and require a fresh explicit edit/save action.

## 19. Failure handling

- No file: use E1 virtual default version 0.
- Existing corrupt/invalid file: fail closed for NEW ENTRY, expose invalid state, and disable normal Web editing until explicit operational repair.
- `patternM15=false` persisted or submitted: invalid/fail closed.
- `rangeEdge=false` persisted or submitted: invalid/fail closed.
- Atomic write failure: keep prior file/version intact.
- Runtime precondition failure: no write, no version change.
- Version conflict: no write, no automatic retry.
- Mid-cycle version change: no order; audit `ENTRY_CONFIG_VERSION_CHANGED`.
- Invalid config at final pre-order recheck: no order.
- Disabled observation unavailable: report IGNORED without blocking.
- Mandatory anchor cannot determine side: report FAIL and block entry.

## 20. Scope isolation

This feature must not change:

- position-management state machines;
- HOLD reason behavior except entry-only observability extensions;
- break-even at +6;
- one-third partial close at +10;
- structural trailing;
- TP2 / Recovery TP;
- exit criteria;
- lot/risk configuration or limits;
- LIVE ARM UI/authorization;
- account-switch semantics;
- lifecycle-broker START/STOP behavior;
- Telegram control semantics.

No unrelated refactor is part of this work.

## 21. TDD and verification contract

Implementation follows RED -> prove exact RED cause -> minimal production fix -> GREEN -> full regression CI -> exact SHA.

Before production changes, RED contracts must cover at minimum:

1. E1 defaults produce the same Trend and Sideway entry-gate decisions as current behavior.
2. Virtual no-file default is version 0; first successful save persists version 1.
3. PASS/FAIL/IGNORED semantics work for every toggleable condition.
4. Mandatory anchors never normalize to IGNORED.
5. D1 AND semantics require every enabled condition to pass.
6. A1 rejects zero-enabled invalid state.
7. B2 proves one shared canonical profile across DEMO and LIVE.
8. C1 rejects writes outside PAUSE or with XAUUSD positions > 0 and leaves state unchanged.
9. F1 rejects attempts to alter internal parameters/thresholds.
10. G1 rejects `sideway.rangeEdge=false` in validation/API and treats persisted false as invalid.
11. G1 proves `m5Confirmation=false` becomes IGNORED while `rangeEdge` remains the Sideway side source.
12. G1 proves enabled M5 confirmation must agree with the `rangeEdge` side.
13. G2a rejects `trend.patternM15=false` in validation/API and treats persisted false as invalid.
14. G2a proves Trend side originates from `patternM15`; other directional confirmations may only agree/fail.
15. Unknown/missing/non-boolean keys fail validation.
16. Existing corrupt/invalid config fails closed and is not normally editable via Web.
17. Atomic writes either produce a complete new version or preserve the prior state.
18. Successful writes increment version exactly once.
19. Stale `expectedVersion` returns conflict and performs no write.
20. Executors consume a newly saved profile on the next entry cycle without restart.
21. Mid-cycle version change produces `ENTRY_CONFIG_VERSION_CHANGED` and no order mutation.
22. Disabled toggleable conditions remain IGNORED and are never normalized to PASS.
23. Safety/orchestration gates have no disabling strategy toggle and remain mandatory.
24. Existing Trend default entry regression remains GREEN.
25. Existing Sideway default entry regression remains GREEN.
26. HOLD/BE/+10/Recovery/exit-management regressions remain GREEN.
27. Web locked-anchor rendering, save/restore/default-draft, runtime lock, and version-conflict behavior are covered.
28. API build, Web build, lifecycle/broker regressions, decision-observability regressions, Trend/Sideway regressions, and Windows-compatible contract suites remain GREEN.

Testing must not send LIVE or DEMO orders. Synthetic/pure contract tests are sufficient for the order boundary.

## 22. Success criteria

Complete only when all are true:

- Operator can enable/disable approved non-mandatory Trend and Sideway conditions from Web.
- Trend `patternM15` is always enabled and is the canonical Trend directional anchor.
- Sideway `rangeEdge` is always enabled and is the canonical Sideway directional anchor.
- Sideway `m5Confirmation` remains independently toggleable.
- Saving is possible only in PAUSE with zero XAUUSD positions.
- DEMO and LIVE use the same canonical profile.
- Enabled conditions use AND semantics.
- Defaults preserve current behavior exactly.
- Internal parameters remain non-editable.
- Executors apply saved changes next entry cycle without restart.
- Mixed-version order submission is impossible by contract.
- Invalid persisted configuration fails closed.
- Mandatory safety gates cannot be disabled.
- Existing position management is unchanged.
- Audit reports config version, canonical side, anchor, and PASS/FAIL/IGNORED per condition.
- Full CI/regression is green with no LIVE/DEMO order test.

## 23. Implementation boundary guidance

Prefer small isolated units:

- API canonical strategy-entry-condition service: schema/default/validation/mandatory anchors/version/atomic persistence;
- API route: GET/POST and runtime save guards;
- shared executor loader/evaluator: validated snapshot, anchor resolution, PASS/FAIL/IGNORED composition, version recheck;
- Trend adapter: maps existing observations to condition IDs while preserving `patternM15` as side origin;
- Sideway adapter: maps existing observations to condition IDs while preserving `rangeEdge` as side origin and M5 as optional confirmation;
- decision-audit extension: entry-condition telemetry/reasons;
- Web editor: locked anchors, editable toggles, draft state, runtime lock, Save/Restore/Default, version conflict handling, condition status display;
- dedicated RED contracts plus existing regression workflows.

The implementation plan must avoid duplicating condition semantics across API, Trend, Sideway, and Web and must not move mandatory safety checks into the editable strategy profile.
