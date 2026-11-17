# Customer Product Access V1

## Goal

Support two customer delivery models without distributing proprietary Master strategy logic:

1. `SELF_MANAGED` — customer runs an authorized bot runtime on their own installation/account and may control only explicitly granted bot modes.
2. `COPY_FOLLOWER` — customer receives signed Master lifecycle commands through the copy boundary and chooses only explicitly granted follower sizing modes.

This layer is authorization only. It does not change trading logic, risk logic, AUTO behavior, ARM behavior, order execution, position management, FastMove, M5, REVERSAL, Sideway, or Trend rules.

## Existing security foundation

V1 reuses the already-approved public-contract components on main:

- `@xauusd/copy-protocol`
- `@xauusd/license-service`
- `@xauusd/installation-proof`

The two-product entitlement policy itself lives in the private-only `@xauusd/customer-product-access` package. The three governed public packages remain byte-for-byte aligned with `security/public-contract.lock.json`. The Master/Core repository remains private and canonical. Strategy internals and commercial product entitlements remain server-side.

## Product modes

### SELF_MANAGED

A Self-Managed product grant binds:

- license ID
- customer ID
- installation ID
- parent license validity
- allowed MT5 logins from the parent license
- allowed broker servers from the parent license
- explicit customer bot-mode allowlist

Supported bot modes:

- `PAUSE`
- `AUTO`
- `SEMI`
- `TREND`
- `SIDEWAY`

Every Self-Managed grant must allow `PAUSE`.

`PAUSE` remains available as a safety control even when the parent license has expired or is suspended, provided the installation/account binding is valid. This prevents licensing from blocking a safe stop.

Any mode capable of new exposure requires:

- exact installation match
- exact MT5 login allowlist match
- exact broker server allowlist match
- active parent license
- valid unexpired product grant
- requested bot mode explicitly allowed

This product-access layer does not authorize order creation directly. The normal Phase7C execution, mode, ARM, risk and broker safety gates remain authoritative.

### COPY_FOLLOWER

A Copy-Follower grant has no bot-mode entitlement.

It authorizes only explicitly configured sizing modes:

- `EQUITY_RATIO`
- `LOT_MULTIPLIER`
- `FIXED_LOT`

Copy-Follower new exposure requires:

- exact installation match
- exact MT5 login allowlist match
- exact broker server allowlist match
- active parent license
- valid unexpired product grant
- requested sizing mode explicitly allowed

Existing-position risk-reducing behavior continues to use the existing action-sensitive license authorization matrix. Expiry/revocation must not prevent an authenticated close, partial close, reconciliation snapshot, or non-loosening SL update for an already matched position.

## Separation contract

A `SELF_MANAGED` grant must not contain Copy-Follower sizing entitlements.

A `COPY_FOLLOWER` grant must not contain bot-mode entitlements.

The same installation/customer may receive multiple separate grants only when the commercial plan explicitly permits both products. Each grant remains independently auditable and revocable.

## Customer-facing architecture

```text
Private Master/Core
      |
      +-------------------------+
      |                         |
SELF_MANAGED                 COPY_FOLLOWER
      |                         |
License + Product Grant      Signed Copy Commands
Installation Proof           License + Product Grant
      |                         |
Customer Runtime            Thin Follower Agent
      |                         |
Customer MT5                Customer MT5
```

## Admin model

The future admin service/dashboard should manage at least:

```text
customerId
licenseId
grantId
productMode
installationId
allowedMt5Logins
allowedBrokerServers
allowedBotModes
allowedCopySizingModes
issuedAt
expiresAt
licenseStatus
```

No strategy parameters or proprietary decision internals are customer-configurable through this layer.

## Acceptance requirements

The implementation is accepted only if tests prove:

1. active Self-Managed grant can authorize an explicitly allowlisted mode;
2. Self-Managed grant always includes `PAUSE`;
3. expired/suspended license cannot authorize new exposure mode;
4. safe `PAUSE` remains available with valid installation/account binding;
5. wrong installation is rejected;
6. wrong MT5 login is rejected;
7. wrong broker server is rejected;
8. Self-Managed grant cannot be used at Copy-Follower boundary;
9. Copy-Follower grant cannot be used at Self-Managed boundary;
10. Copy-Follower sizing mode must be explicitly allowlisted;
11. expired product grant blocks Copy-Follower new exposure;
12. grant customer/license/installation binding must exactly match the parent license;
13. grant validity must be contained inside parent license validity;
14. license-service keeps no proprietary strategy/execution dependency;
15. no persistence/network/MT5 mutation path is added to the authorization package.

## Production safety boundary

This phase is source/CI only.

```text
PRODUCTION_MUTATION=NONE
BOT_RUNTIME_MUTATION=NONE
MODE_MUTATION=NONE
ARM_MUTATION=NONE
ORDER_MUTATION=NONE
POSITION_MUTATION=NONE
LIVE_TEST_ORDER=NONE
```

A later phase may add API/admin persistence and follower/runtime integration only after exact-head CI passes and a separate rollout is approved.
