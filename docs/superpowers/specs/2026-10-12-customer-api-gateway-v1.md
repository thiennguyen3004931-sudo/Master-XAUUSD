# Authenticated Customer API Gateway V1

## Goal

Expose the existing customer security/runtime stack through a narrowly scoped authenticated HTTPS gateway without exposing Master trading controls or source code.

## Endpoints

### POST /v1/customer/runtime/challenge

Exact JSON body:

- productMode: SELF_MANAGED | COPY_FOLLOWER
- grantId
- installationId

The gateway authenticates the customer first, rate-limits the caller, verifies that the requested grant belongs to the authenticated customer and exact installation/product mode, then delegates challenge issuance to the existing Runtime Session.

### POST /v1/customer/runtime/activate

SELF_MANAGED exact body:

- productMode
- grantId
- installationId
- mt5Login
- brokerServer
- requestedBotMode
- proof

COPY_FOLLOWER exact body:

- productMode
- grantId
- installationId
- mt5Login
- brokerServer
- requestedSizingMode
- proof

The gateway removes only the transport discriminator `productMode` and delegates the remaining activation request to the existing Runtime Session / Runtime Gate.

## Authentication

V1 uses Bearer tokens whose SHA-256 hashes are configured server-side.

- plaintext tokens are not stored by the authenticator;
- candidate token comparison uses `timingSafeEqual`;
- the authenticated principal supplies only `customerId`;
- grant ownership remains server-side;
- caller-supplied customerId is rejected by exact-schema validation.

No credential or secret is committed to the repository.

## Rate limiting

A bounded fixed-window limiter is provided behind an interface.

Both source IP and authenticated customer ID receive independent buckets.

Default:

- 60 requests
- per 60 seconds

Production can replace the limiter without changing gateway behavior.

## Request safety

- HTTPS adapter only;
- POST only;
- JSON content type required;
- exact schemas;
- 32 KiB body limit;
- unknown paths return 404;
- wrong methods return 405;
- missing/bad authentication returns 401;
- cross-customer or wrong installation/product access returns 403;
- rate-limit denial returns 429;
- server-side grant/license/session failures fail closed.

## Trust boundary

Customer controls:

- Bearer token
- grantId
- installationId
- product-specific activation fields
- signed installation proof

Server controls:

- token hash records
- authenticated customer identity
- grant registry
- license resolver
- challenge store
- clock
- runtime gate

## Isolation

The API gateway may use `node:http` / `node:https` only inside the dedicated `api-gateway.ts` adapter.

It must not depend on:

- strategy-engine
- risk-engine
- execution-engine
- mt5-broker

It must not:

- ARM the bot
- change BOT_MODE
- place/modify/close orders
- modify positions
- expose Master strategy source

## Acceptance

CI proves:

1. authenticated SELF_MANAGED challenge issuance;
2. signed SELF_MANAGED activation;
3. replay rejection;
4. authenticated COPY_FOLLOWER challenge + activation;
5. missing authentication denied;
6. cross-customer grant access denied;
7. rate limiting enforced;
8. oversized bodies rejected;
9. exact JSON schemas enforced;
10. only the gateway adapter has network access;
11. no trading/MT5 mutation is introduced.

## Next phase

Customer Agent V1 will consume only this gateway contract and installation-proof contract.

## Safety boundary

```text
CUSTOMER_API_GATEWAY=AUTHENTICATED_HTTPS
TRADING_LOGIC_MUTATION=NONE
MT5_MUTATION=NONE
MODE_MUTATION=NONE
ARM_MUTATION=NONE
ORDER_MUTATION=NONE
POSITION_MUTATION=NONE
LIVE_TEST_ORDER=NONE
```
