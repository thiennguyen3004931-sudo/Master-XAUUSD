# Customer Provisioning V1

## Goal

Add a private, source-only provisioning contract that issues customer product grants for the two approved delivery models:

1. `SELF_MANAGED`
2. `COPY_FOLLOWER`

Provisioning must derive identity/account binding from an already-valid parent license rather than accepting customer, installation, MT5, or broker identity from free-form admin input.

## Scope

This phase adds pure grant construction and validation inside `@xauusd/customer-product-access`.

It does not add:

- database persistence
- HTTP/API routes
- dashboard mutations
- MT5 communication
- trading runtime integration
- ARM/AUTO changes
- order or position mutations
- copy transport

## SELF_MANAGED issuance

Admin input is limited to:

- grant ID
- issued-at timestamp
- expiry timestamp
- explicit bot-mode allowlist

The issued grant derives:

- license ID
- customer ID
- installation ID

from the parent license.

`PAUSE` is automatically included exactly once, even when omitted from admin input. This keeps the safety stop available by construction.

No Copy-Follower sizing entitlement is accepted or emitted.

## COPY_FOLLOWER issuance

Admin input is limited to:

- grant ID
- issued-at timestamp
- expiry timestamp
- explicit copy sizing allowlist

At least one sizing mode is required.

No bot-mode entitlement is accepted or emitted.

## Issuance gate

A grant can be issued only when:

- the parent license record is valid;
- the parent license is effectively `ACTIVE` at the grant issue time;
- grant issue/expiry timestamps are safe integers;
- grant expiry is strictly after grant issue time;
- grant validity is fully contained inside parent-license validity;
- grant ID is canonical and non-blank;
- requested entitlements are valid and duplicate-free.

The provisioning layer then validates the constructed grant through the existing `assertCustomerProductGrant` contract before returning it.

## Security properties

- customer/license/installation identity is inherited, not typed by the admin;
- product entitlements cannot bleed between Self-Managed and Copy-Follower;
- grant lifetime cannot exceed parent-license lifetime;
- no strategy, risk, execution, MT5, persistence, or network dependency is introduced;
- existing customer authorization remains the runtime authority after provisioning.

## Acceptance requirements

Tests must prove:

1. Self-Managed issuance derives the exact parent binding;
2. Self-Managed issuance injects `PAUSE` exactly once;
3. a PAUSE-only Self-Managed grant is valid;
4. invalid or duplicate bot modes are rejected;
5. Copy-Follower issuance requires at least one valid sizing mode;
6. invalid or duplicate sizing modes are rejected;
7. grant lifetime cannot begin before or end after the parent license;
8. suspended/revoked/expired parent licenses cannot issue new grants at the requested issue time;
9. free-form cross-product entitlement fields are rejected;
10. issued grants pass the existing authorization layer.

## Production safety boundary

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
