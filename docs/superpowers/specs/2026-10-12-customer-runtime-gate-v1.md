# Customer Runtime Gate V1

## Goal

Close the stale-record bypass between customer runtime callers and activation.

Before this phase, `customer-activation` correctly validated a supplied lifecycle and license, but the caller still supplied those records. A caller retaining an older ACTIVE lifecycle or license object could therefore attempt to bypass a later server-side revoke or suspension.

V1 introduces a transport-neutral runtime gate that accepts only a `grantId` plus activation request fields. The gate resolves the current lifecycle and current license from server-side sources before calling the existing activation layer.

## Trust boundary

Caller-controlled input may contain:

- grant ID
- installation ID
- MT5 login
- broker server
- requested SELF_MANAGED bot mode or COPY_FOLLOWER sizing mode
- installation proof

Caller-controlled input must not contain:

- lifecycle record
- license record
- license status
- grant status
- product permissions
- installation public key
- current/server timestamp
- one-time challenge consumer

The server injects a trusted clock and one-time challenge consumer separately from caller input. Exact-key validation rejects attempts to smuggle either field in the runtime request before repository or license resolution.

## Server-side resolution

Activation order:

1. validate exact runtime request shape;
2. validate the server security context and read trusted server time;
3. fetch the current lifecycle by `grantId`;
4. validate the lifecycle source;
5. require the expected product mode;
6. fetch the current license by the lifecycle's `licenseId`;
7. validate the license source and exact license ID;
8. delegate to the approved customer activation flow using server time and the server-owned one-time consumer;
9. lifecycle access remains before installation proof consumption;
10. when activation would allow new exposure, re-read server time, lifecycle and license;
11. fail closed with `RUNTIME_STATE_CHANGED` if authorization state changed, time moved backward, or the grant/license became ineffective during proof verification.

This prevents callers from selecting stale lifecycle/license objects and closes the revoke/suspend race between initial authorization and exposure activation.

## Fail-closed outcomes

Runtime-specific failures include:

- INVALID_RUNTIME_REQUEST
- GRANT_NOT_FOUND
- INVALID_GRANT_SOURCE
- PRODUCT_MODE_MISMATCH
- LICENSE_NOT_FOUND
- INVALID_LICENSE_SOURCE
- INVALID_RUNTIME_SECURITY_CONTEXT
- RUNTIME_STATE_CHANGED

Existing activation failures remain unchanged.

## Safety semantics

- revoked SELF_MANAGED grant blocks AUTO/SEMI/TREND/SIDEWAY new exposure;
- PAUSE remains a non-exposure safety path where the approved lifecycle rules allow it;
- suspended/expired/revoked current licenses block new exposure;
- revoked COPY_FOLLOWER grants block follower activation;
- wrong product mode fails before installation proof consumption.

## Out of scope

V1 adds no:

- Express/API route
- production runtime mounting
- MT5 dependency
- strategy/risk/execution dependency
- order placement
- position mutation
- AUTO/ARM mutation
- network implementation
- persistence implementation

## Acceptance

Tests must prove:

1. SELF_MANAGED activation loads lifecycle and license from server-side sources;
2. caller-supplied lifecycle/license/time/replay-consumer fields are rejected before any source access;
3. current revoked grant blocks AUTO before proof consumption;
4. PAUSE remains safe after revocation;
5. current suspended license blocks exposure before proof consumption;
6. missing grant/license fails closed;
7. COPY_FOLLOWER uses the same server-side resolution path;
8. product mode mismatch fails before proof consumption;
9. grant revoke during proof verification blocks exposure;
10. license status change during proof verification blocks exposure;
11. server time crossing grant/license expiry during proof verification blocks exposure;
12. invalid server clock/replay-consumer context fails closed;
13. package has no trading, MT5, persistence, network, or API route dependency.

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
