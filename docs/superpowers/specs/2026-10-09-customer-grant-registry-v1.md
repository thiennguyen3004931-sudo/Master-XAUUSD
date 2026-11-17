# Customer Grant Registry / Admin Service V1

## Goal

Add a private source-only registry and administration layer for customer product grant lifecycle records.

The registry is an application boundary, not a database and not a network service. V1 provides a repository interface plus an in-memory reference implementation so lifecycle behavior can be tested before any persistence or API rollout.

## Source of truth

The registry stores the existing `CustomerProductGrantLifecycleRecord`.

It does not duplicate or persist dynamic parent-license status. The existing license service remains authoritative for license state.

## Repository contract

The repository supports:

- exact lookup by grant ID;
- optimistic compare-and-set using lifecycle revision;
- deterministic listing of lifecycle records.

The in-memory implementation:

- stores defensive immutable snapshots;
- returns defensive immutable snapshots;
- enforces exact grant-ID binding;
- rejects invalid expected revisions;
- provides no filesystem, database, or network behavior.

## Registration

Initial registration accepts only:

- a valid lifecycle record;
- status `ACTIVE`;
- `revokedAt=null`;
- revision `1`.

Repeated registration of the exact same lifecycle record is idempotent.

Reuse of an existing grant ID for different grant content fails closed with `GRANT_ID_CONFLICT`.

## Revocation

Administrative revocation:

- requires an already registered grant;
- uses the approved lifecycle revocation function;
- preserves the first revocation timestamp;
- is idempotent after revocation;
- uses optimistic revision compare-and-set;
- fails closed on a revision conflict.

## Admin views

Read-only admin views flatten the grant lifecycle into:

- grant ID
- license ID
- customer ID
- product mode
- installation ID
- bot-mode or copy-sizing allowlist
- issued/expires timestamps
- lifecycle status
- revocation timestamp
- revision
- effective grant status at a caller-supplied timestamp

Views can be filtered by:

- customer ID
- license ID
- installation ID
- product mode
- lifecycle status

The registry does not expose strategy parameters or customer-configurable strategy/risk settings.

## Out of scope

V1 adds no:

- database persistence
- filesystem persistence
- HTTP/API routes
- web dashboard
- authentication transport
- activation session persistence
- MT5 communication
- strategy/risk/execution dependency
- ARM/AUTO mutation
- order or position mutation

## Acceptance requirements

Tests must prove:

1. valid ACTIVE revision-1 lifecycle registration succeeds;
2. exact duplicate registration is idempotent;
3. conflicting reuse of a grant ID fails closed;
4. revoked lifecycle cannot be registered as an initial state;
5. revocation preserves the first timestamp and is idempotent;
6. missing grants cannot be revoked implicitly;
7. optimistic revision conflict fails closed;
8. admin views are immutable and derive effective status from lifecycle time rules;
9. filtering is deterministic;
10. the package depends only on customer product access;
11. no persistence, network, trading, MT5, order, or position implementation is introduced.

## Production safety boundary

```text
PUBLIC_CONTRACT_MUTATION=NONE
PRODUCTION_MUTATION=NONE
BOT_RUNTIME_MUTATION=NONE
MODE_MUTATION=NONE
ARM_MUTATION=NONE
ORDER_MUTATION=NONE
POSITION_MUTATION=NONE
LIVE_TEST_ORDER=NONE
PERSISTENCE_MUTATION=NONE
NETWORK_MUTATION=NONE
```
