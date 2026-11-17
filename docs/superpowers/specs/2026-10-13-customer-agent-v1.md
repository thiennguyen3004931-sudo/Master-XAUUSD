# Customer Agent V1

## Goal

Provide the customer-side client used to authenticate to the Customer API Gateway and activate either SELF_MANAGED or COPY_FOLLOWER access without distributing Master trading logic.

## Trust boundary

The customer agent holds only:

- customer API bearer token;
- grant ID;
- installation ID;
- installation public/private Ed25519 key material;
- the customer's allowed MT5 login and broker server;
- the requested customer product mode configuration.

The agent has no dependency on:

- strategy engine;
- risk engine;
- execution engine;
- MT5 broker bridge;
- Master runtime;
- customer server persistence;
- grant registry;
- license repository.

## Flow

1. POST authenticated request to /v1/customer/runtime/challenge.
2. Require a RECONNECT challenge bound to the local installation.
3. Sign the challenge with the local installation private key.
4. POST authenticated activation to /v1/customer/runtime/activate.
5. Fail closed for invalid/mismatched challenge or gateway rejection.

## Supported product modes

### SELF_MANAGED

The client may request one of the explicit customer bot modes:

- PAUSE
- AUTO
- SEMI
- TREND
- SIDEWAY

Authorization remains server-side. The agent does not change the Master bot mode itself.

### COPY_FOLLOWER

The client may request one allowed sizing mode:

- EQUITY_RATIO
- LOT_MULTIPLIER
- FIXED_LOT

Authorization remains server-side.

## Transport

The production transport is HTTPS only.

- no plain HTTP;
- no cross-origin redirect construction;
- bounded request/response body;
- bounded request timeout;
- Bearer authentication;
- no embedded server secret.

## Retry policy

Only transport errors and 429/503 are retried.

Retries are bounded to 3 attempts with deterministic backoff.

401/403 and other authorization failures are not retried.

## Safety

The agent has no direct order, position, ARM, or Master mode mutation API.

This phase does not send any LIVE trading order.

## Acceptance

CI proves:

1. SELF_MANAGED challenge -> proof -> activation;
2. COPY_FOLLOWER challenge -> proof -> activation;
3. installation mismatch fails closed;
4. authorization rejection is not retried;
5. transient failures use bounded retry;
6. client dependency boundary excludes Master trading/runtime packages;
7. network code is isolated to HTTPS transport.

## Next

After merge:

1. SELF_MANAGED simulated E2E;
2. COPY_FOLLOWER simulated E2E;
3. revoke/new-machine migration;
4. Final Customer Production Acceptance.
