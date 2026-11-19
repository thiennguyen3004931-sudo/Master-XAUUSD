# Customer Security Store V1

## Goal

Add durable local persistence for customer licensing and runtime session security before any remote customer API is exposed.

This phase persists:

1. current customer license records;
2. customer grant lifecycle records with compare-and-set revision semantics;
3. one-time RECONNECT challenges and their consumed state.

It does not expose HTTP routes and does not mutate bot, ARM, MT5, orders, or positions.

## Storage engine

V1 uses Node.js 24 `node:sqlite` through a local SQLite database.

Reasons:

- transactional single-file persistence;
- safe uniqueness constraints;
- durable one-time challenge state across process restart;
- no external database service or new npm dependency;
- better crash semantics than ad-hoc JSON temp/rename files on Windows.

Durability settings:

- WAL journal mode;
- synchronous = FULL;
- foreign keys enabled;
- bounded busy timeout.

## Adapters

### SqliteCustomerLicenseRepository

Implements the existing server-side license resolver contract and adds explicit durable `put()`.

License payloads are validated with `assertLicenseRecord` both before write and after read.

### SqliteCustomerGrantRegistryRepository

Implements `CustomerGrantRegistryRepository`.

It preserves:

- create-only insert when expected revision is null;
- conditional update when current revision equals the expected revision;
- deterministic grant listing;
- lifecycle validation on read and write.

### SqliteCustomerRuntimeChallengeStore

Implements `CustomerRuntimeChallengeStore`.

It preserves:

- unique challenge ID;
- issued/expires timestamps;
- one-time consumption;
- consumed state across process restart;
- fail-closed consume before issue time or after expiry.

## Composition

`SqliteCustomerSecurityStore` owns one database connection and exposes:

- `licenses`
- `grants`
- `challenges`

The application can pass these adapters directly into the existing Runtime Session and Runtime Gate stack.

## Acceptance

CI must prove:

1. license survives close/reopen;
2. grant survives close/reopen;
3. stale grant revision cannot overwrite current state;
4. correct grant revision can update current state;
5. challenge survives close/reopen;
6. duplicate challenge ID is rejected;
7. consumed challenge remains consumed after close/reopen;
8. expired/not-yet-valid challenge fails closed;
9. persistence is isolated to the SQLite adapter;
10. no trading, MT5, API, network, mode, ARM, order, or position mutation is introduced.

## Production boundary

This phase is persistence infrastructure only.

Not included yet:

- authenticated HTTP API;
- customer agent transport;
- remote enrollment endpoint;
- remote activation endpoint;
- rate limiting;
- production database-path wiring;
- backup/restore policy;
- key rotation workflow;
- production migration command.

## Next phase

After this store is accepted:

1. merge Customer Runtime Session V1;
2. merge Customer Security Store V1;
3. add authenticated/rate-limited Customer API Gateway;
4. add Customer Agent;
5. run SELF_MANAGED E2E;
6. run COPY_FOLLOWER E2E;
7. run revoke and new-PC migration acceptance.

## Safety boundary

```text
PERSISTENCE_ADAPTER=SQLITE_LOCAL
PRODUCTION_PERSISTENCE_WIRING=NONE
NETWORK_MUTATION=NONE
API_ROUTE_MUTATION=NONE
TRADING_LOGIC_MUTATION=NONE
BOT_RUNTIME_MUTATION=NONE
MODE_MUTATION=NONE
ARM_MUTATION=NONE
ORDER_MUTATION=NONE
POSITION_MUTATION=NONE
LIVE_TEST_ORDER=NONE
```
