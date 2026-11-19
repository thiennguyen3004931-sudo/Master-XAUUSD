# Customer Activation V1

## Goal

Add a private activation gate that composes the already-approved customer product authorization with installation proof verification.

Activation is not trading execution. It only decides whether the presented customer installation is allowed to activate the requested product capability.

## Inputs

The activation boundary receives:

- parent license
- customer product grant lifecycle record
- installation proof for a RECONNECT challenge
- installation ID
- MT5 login
- broker server
- current timestamp
- requested Self-Managed bot mode or Copy-Follower sizing mode
- single-use challenge consumer

## Ordering

1. Product lifecycle authorization runs first; revoked grants fail closed for new exposure.
2. If access fails, the installation challenge is not consumed.
3. If access succeeds, the installation proof must verify against:
   - exact license ID
   - exact installation ID
   - exact installation public key bound to the license
   - valid challenge lifetime
   - valid Ed25519 signature
   - one-time challenge consumption
4. Only then does activation return success.

This ordering prevents unauthorized requests from burning a valid one-time challenge.

## SELF_MANAGED

Activation requires the existing Self-Managed lifecycle access decision plus valid installation proof. Revoked grants cannot activate new-exposure modes, while safety PAUSE remains available with valid binding.

The activation response carries through the existing access decision:

- normal authorized modes: exposureAllowed=true
- safety PAUSE: exposureAllowed=false

Activation itself never authorizes an MT5 order.

## COPY_FOLLOWER

Activation requires:

- explicit allowed sizing mode
- exact account/broker/installation binding
- active non-revoked grant lifecycle plus active license for new exposure
- valid bound installation proof

Activation does not transport copy commands and does not execute orders.

## Replay protection

A verified installation challenge is consumed once. Reuse of the same challenge must fail with CHALLENGE_REPLAYED.

## Isolation

The new package may depend only on:

- @xauusd/customer-product-access
- @xauusd/installation-proof
- @xauusd/license-service

It must contain no:

- strategy dependency
- risk dependency
- execution dependency
- MT5 broker dependency
- persistence implementation
- network server/client implementation
- order/position mutation

## Acceptance requirements

Tests must prove:

1. valid Self-Managed activation succeeds only after both access and proof succeed;
2. access denial occurs before challenge consumption;
3. wrong installation public key is rejected;
4. replayed challenge is rejected;
5. valid Copy-Follower activation succeeds for an allowlisted sizing mode;
6. wrong broker/account/product entitlement fails closed;
7. revoked Self-Managed AUTO is blocked before proof consumption;
8. safety PAUSE remains activatable after grant revocation;
9. revoked Copy-Follower activation is blocked before proof consumption;
10. package dependency boundary remains isolated;
11. no runtime, persistence, network, MT5, order, or position mutation is introduced.

## Production boundary

```text
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
