# Customer Grant Persistence / Admin Service V1

## Goal

Add a private source-only persistence adapter and guarded administration command boundary for the approved Customer Grant Registry V1.

This phase does not mount routes into the production API and does not alter the trading runtime.

## Persistent registry

The persistence adapter implements the existing `CustomerGrantRegistryRepository`.

Storage model:

- one immutable JSON snapshot per grant lifecycle revision;
- grant IDs are converted to SHA-256 filenames, so customer-controlled IDs never become paths;
- revision filenames are fixed-width and deterministic;
- snapshots are validated against the existing lifecycle contract on every read;
- revision history must be contiguous;
- grant identity must not change across revisions.

## Windows-safe commit protocol

V1 deliberately avoids replacing an existing state file.

For every new revision:

1. serialize the validated lifecycle snapshot to a unique temp file;
2. flush the temp file with `fsync`;
3. create the immutable final revision using a same-directory hard link;
4. hard-link creation fails if that revision already exists;
5. remove the temp file.

This gives create-if-absent compare-and-set behavior without relying on rename-over-existing semantics, reducing exposure to the Windows `EPERM rename` class previously observed in runtime state handling.

## Optimistic concurrency

- initial registration expects no existing revision and writes revision 1;
- later writes must match the exact current revision;
- the next record must advance exactly one revision;
- concurrent writers for the same target revision race on the same immutable final filename, so only one wins.

## Admin command boundary

The package provides a transport-neutral administration command service.

Supported actions:

- READ_GRANT
- LIST_GRANTS
- REGISTER_GRANT
- REVOKE_GRANT

Every command requires:

- a canonical admin subject;
- an injected `CustomerGrantAdminAuthorizer`;
- authorization before any registry read or write.

There is no built-in allow-all authorizer.

The command service accepts no HTTP request, token, cookie, password, or network transport directly. Authentication remains an upstream concern for a later transport-integration phase.

## Out of scope

V1 does not add:

- routes to `apps/api`;
- Express middleware;
- HTTP listeners;
- web dashboard controls;
- production data migration;
- license storage;
- installation private-key storage;
- strategy/risk/execution dependencies;
- MT5 communication;
- bot mode changes;
- ARM/AUTO changes;
- orders or position changes.

## Acceptance

Tests must prove:

1. revision 1 survives repository reconstruction;
2. revocation survives repository reconstruction;
3. only one concurrent writer can create a given next revision;
4. list returns only latest revisions in deterministic grant order;
5. malformed final snapshots fail closed;
6. revision jumps fail closed;
7. denied admin commands perform no repository operation;
8. invalid actor/command fails before authorization;
9. each allowed admin action maps to the correct registry operation;
10. target grant identity is supplied to authorization;
11. no network, trading, MT5, runtime, order, or position integration is introduced.

## Safety boundary

```text
PUBLIC_CONTRACT_MUTATION=NONE
PRODUCTION_MUTATION=NONE
BOT_RUNTIME_MUTATION=NONE
MODE_MUTATION=NONE
ARM_MUTATION=NONE
ORDER_MUTATION=NONE
POSITION_MUTATION=NONE
LIVE_TEST_ORDER=NONE
PERSISTENCE_IMPLEMENTATION=PRIVATE_SOURCE_ONLY
PRODUCTION_PERSISTENCE_MUTATION=NONE
NETWORK_MUTATION=NONE
API_ROUTE_MUTATION=NONE
```
