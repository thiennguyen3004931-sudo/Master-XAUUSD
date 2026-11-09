# Customer Grant Lifecycle V1

## Goal

Add a private, source-only lifecycle layer for customer product grants so commercial access can be revoked safely without changing strategy or MT5 execution logic.

This phase operates on the existing `CustomerProductGrant` contract and keeps runtime integration out of scope.

## Lifecycle record

Each lifecycle record contains:

- version
- immutable customer product grant
- lifecycle status
- first revocation timestamp
- monotonic revision

Supported lifecycle statuses:

- `ACTIVE`
- `REVOKED`

Grant time validity remains governed by the existing grant `issuedAt/expiresAt` fields.

## Revocation rules

Revocation must be:

- explicit;
- timestamped with a safe integer;
- no earlier than grant issuance;
- immutable after the first revocation;
- idempotent when repeated.

A later repeated revoke request must not rewrite the original revocation time.

## Effective grant status

The lifecycle layer exposes an effective status at a requested time:

- `NOT_YET_VALID`
- `ACTIVE`
- `EXPIRED`
- `REVOKED`

Revocation takes precedence from `revokedAt` onward.

Before `revokedAt`, the original grant time window remains authoritative.

## SELF_MANAGED behavior

For new-exposure-capable modes:

- a revoked grant must fail closed with `GRANT_REVOKED`.

For `PAUSE`:

- safety PAUSE remains available when the installation/account binding is valid;
- revocation must not prevent stopping the bot safely.

The normal parent-license and account/broker binding checks remain authoritative.

## COPY_FOLLOWER behavior

A revoked Copy-Follower grant cannot authorize new copy exposure.

Existing-position close/reconciliation/non-loosening risk-reducing actions remain outside this product-access gate and continue to use the existing copy/license action-sensitive authorization path.

## Isolation

This phase adds no:

- database persistence
- filesystem persistence
- HTTP/API routes
- dashboard mutation
- MT5 communication
- trading strategy dependency
- risk or execution dependency
- ARM/AUTO mutation
- order/position mutation

## Acceptance requirements

Tests must prove:

1. a valid grant can be wrapped as an ACTIVE lifecycle record;
2. effective status observes not-yet-valid, active and expired grant windows;
3. first revocation timestamp is preserved;
4. repeated revocation is idempotent;
5. revocation before grant issuance is rejected;
6. Self-Managed new exposure is blocked after revocation;
7. Self-Managed PAUSE remains available after revocation when binding is valid;
8. Copy-Follower new exposure is blocked after revocation;
9. authorization before a future revocation timestamp remains governed by the original grant;
10. lifecycle records reject unknown or malformed fields;
11. no public-contract package is modified.

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
