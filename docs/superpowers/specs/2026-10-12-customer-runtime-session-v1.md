# Customer Runtime Session V1

## Goal

Create the server-side session layer required before exposing customer runtime activation over HTTP.

The session layer:

1. resolves the current customer grant and license server-side;
2. issues a short-lived RECONNECT challenge bound to the authorized installation;
3. keeps one-time challenge state;
4. verifies signed installation proof through the existing activation/runtime-gate stack;
5. blocks replay;
6. preserves safe PAUSE semantics after grant revocation or license inactivity;
7. never directly mutates MT5, bot mode, ARM, orders, or positions.

## Why this phase exists

Customer Runtime Gate V1 intentionally has no network route and expects a trusted clock plus a one-time challenge consumer.

Before a remote customer API can be mounted, the server needs a canonical way to:

- mint reconnect challenges;
- bind challenges to current server-side grant/license identity;
- consume each challenge once;
- reuse the existing fail-closed Runtime Gate for both product models.

Without this layer, each future HTTP route would need to invent replay and challenge handling independently.

## Supported products

### SELF_MANAGED

Challenge issuance requires exact:

- grant ID;
- product mode = SELF_MANAGED;
- grant customer/license/installation binding;
- current license record;
- requested installation ID.

Challenge issuance itself does not authorize exposure.

This is intentional: a revoked grant or inactive license may still need a fresh signed session to perform safe PAUSE. AUTO/SEMI/TREND/SIDEWAY exposure remains blocked later by Runtime Gate.

### COPY_FOLLOWER

Challenge issuance requires exact:

- grant ID;
- product mode = COPY_FOLLOWER;
- grant customer/license/installation binding;
- current license record;
- requested installation ID.

Follower sizing authorization remains in Runtime Gate and Customer Activation.

## Challenge contract

- purpose = RECONNECT
- TTL = 60 seconds
- cryptographic nonce = installation-proof canonical challenge
- challenge ID consumed once
- replayed challenge is rejected
- expired challenge is rejected
- challenge store errors fail closed

## Trust boundary

Caller controls only:

- grantId
- installationId
- later activation request fields
- signed installation proof

Server controls:

- grant registry
- license resolver
- current clock
- challenge creation
- challenge one-time store
- Runtime Gate invocation

## V1 store

V1 includes an in-memory one-time challenge store for source/CI validation.

It is intentionally not mounted into production and is not durable across process restart.

A persistent challenge store is required before remote production API rollout.

## Acceptance

Tests prove:

1. SELF_MANAGED reconnect challenge is issued only for exact installation binding;
2. signed proof activates an authorized AUTO session;
3. replay of the same challenge fails;
4. COPY_FOLLOWER grant cannot mint SELF_MANAGED challenge;
5. COPY_FOLLOWER challenge activates only its approved sizing path;
6. suspended license may obtain identity challenge but cannot activate AUTO exposure;
7. revoked SELF_MANAGED grant may still authenticate for safe PAUSE;
8. expired challenge fails proof verification;
9. package has no MT5/trading/API/network/persistence dependency;
10. no production or runtime mutation occurs.

## Next phase

Before mounting remote HTTP routes:

1. add durable one-time challenge persistence;
2. add server-side license persistence/resolver;
3. add authenticated/rate-limited challenge and activation HTTP adapter;
4. add customer agent transport;
5. keep copy execution path separated from Master trading runtime.

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
PERSISTENCE_MUTATION=NONE
NETWORK_MUTATION=NONE
API_ROUTE_MUTATION=NONE
```
