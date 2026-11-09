# Phase7C P2 Performance Intelligence — Completion Design

Date: 2026-09-04
Base: `main@4759087e205b430ed6cbaa39c2922c043d787667`
Scope: P2.1–P2.10

## Safety contract

P2 is observability only.

- strategy mutation: NONE
- risk mutation: NONE
- order mutation: NONE
- position mutation: NONE
- bot mode mutation: NONE
- ARM mutation: NONE
- AUTO retune: NONE
- LIVE test order: NONE
- executor restart: NONE
- bridge restart: NONE

All new APIs are GET-only and `cache-control: no-store`.

## P2.1 Inventory

### Canonical decision / audit sources

The Phase7C Performance Intelligence service resolves the account-aware runtime root:

`.runtime/phase7c-executors/decision-observability/<account-mode>/`

Canonical streams:

- `trend-decisions.jsonl`
- `sideway-decisions.jsonl`

The service already parses explicit identity fields recursively and normalizes them as:

- `POSITION:<id>` from position identifiers and qualifying entry tickets
- `ORDER:<id>` from order/client-order/idempotency identifiers
- `SIGNAL:<id>` from signal identifiers

It also extracts persisted rule evidence from canonical entry-condition containers and regime / entry-type fields.

LIVE is account-isolated and must not fall back to a legacy decision path.

### Canonical accounting sources

Performance Intelligence reuses `getMt5PerformanceSnapshot(days, symbol)` from the read-only MT5 performance service. It does not independently reconstruct broker PnL.

The repository also exposes the canonical Phase7C deal-ledger route/service for position-realized accounting. That ledger remains the canonical deal-accounting authority; P2 does not mutate or fork it.

### Existing correlation behavior

Existing correlation is fail-closed and explicit-ID only:

- exact component with one system position -> `EXACT`
- identity component spanning more than one system position -> `AMBIGUOUS`
- no explicit identity component -> `UNMATCHED`

No timestamp proximity or price proximity is allowed for attribution.

### Existing P2 slice

Already present on main before this completion slice:

- read-only Performance Intelligence service
- GET `/api/v1/phase7c/performance-intelligence`
- rule and entry-type aggregates
- explicit-ID correlation
- source and semantic contract tests
- dedicated `phase7c-performance-intelligence-ci.yml`

Missing from the requested P2 completion scope:

- an explicit versioned canonical correlation-row schema
- an independently consumable read-only correlation/backfill view
- GET correlations API
- Control Center Performance Intelligence UI
- UI/API/schema CI coverage
- production acceptance evidence for the completed slice

## P2.2 Canonical correlation schema

Schema version: `phase7c-performance-correlation-v1`.

Each row represents one closed SYSTEM trade from canonical MT5 performance accounting plus, only when exact, the persisted decision identity evidence that can be proven from runtime decision audits.

### Required row envelope

```text
schemaVersion
tradeKey
symbol
accountMode
trade
  performanceTradeId
  positionId
  strategy
  side
  volume
  openedAt
  closedAt
  netPnl
correlation
  verdict = EXACT | AMBIGUOUS | UNMATCHED
  method = EXPLICIT_IDENTITY_GRAPH | NONE
  evidence[]
  candidatePositionCount
attribution
  entryType = IMMEDIATE | PULLBACK | RECOVERY | UNKNOWN
  regime
  passedRules[]
  blockedRules[]
  decisionEventIds[]
source
  accounting = MT5_ACCOUNT_READ_ONLY
  decisionAuditRoot
  decisionStreams[]
```

Rules:

1. `tradeKey` is deterministic from canonical performance trade identity and position identity.
2. Decision attribution fields are populated only for `EXACT` rows.
3. `AMBIGUOUS` must not choose one candidate.
4. `UNMATCHED` must not infer an identity.
5. Historical gaps remain gaps. Backfill is reconstruction of provable existing evidence, not inference.
6. Schema rows are generated read-only and never written back into executor/runtime state.

## P2.3 Contract tests

RED contracts must prove the completion slice is absent before implementation:

- schema version/export exists
- correlation rows preserve fail-closed verdicts
- backfill summary counts EXACT/AMBIGUOUS/UNMATCHED deterministically
- GET `/correlations` exists and no mutation method exists
- Control Center renders a read-only Performance Intelligence card
- UI transport uses GET only and no mutation verbs
- CI covers API schema, service, route, and web UI files

## P2.4–P2.6 Service, backfill, API

Implementation extends the existing service rather than replacing it.

- retain existing `/` snapshot for compatibility
- expose canonical correlation rows derived from the same in-memory read-only snapshot
- expose `GET /correlations?days=&symbol=&limit=&verdict=&strategy=`
- default days 90, existing 7–365 bound
- limit bounded 1–500, default 100
- no persistence and no runtime writes

The backfill view is the full deterministic correlation-row set built from current broker/account history plus persisted decision audits. It reports counts and source coverage. It deliberately does not manufacture missing historical links.

## P2.7 Control Center UI

Add a `Phase7CPerformanceIntelligenceCard` to `Phase7CControlCenterShellPage`.

Default view:

- READ ONLY badge
- total system trades
- exact / ambiguous / unmatched
- exact coverage percent
- top rule evidence / entry-type summary
- explicit warning when attribution is incomplete

Expanded view:

- source streams and malformed-row counts
- recent canonical correlation rows
- attribution details only where exact

Polling interval: 15 seconds. No controls capable of mutating strategy, risk, orders, mode, ARM, or runtime.

## P2.8–P2.10 Delivery

1. RED contract commit and observed failing CI.
2. GREEN implementation.
3. Dedicated P2 CI plus canonical PR gate.
4. Non-draft PR from exact tested head.
5. Merge only after required checks succeed and head SHA is unchanged.
6. Production acceptance follows P1 discipline: accepted source commit, deployed/source attestation, GET-only runtime verification, no restart/order/ARM mutation. If production transport is unavailable, acceptance remains explicitly NOT PROVEN rather than inferred.
