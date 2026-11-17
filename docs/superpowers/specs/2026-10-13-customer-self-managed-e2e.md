# Customer SELF_MANAGED E2E Acceptance

## Goal

Prove the complete SELF_MANAGED customer handoff chain without touching LIVE trading.

## Covered flow

1. generate customer installation key pair;
2. create license bound to customer, MT5 account, broker, and installation;
3. create SELF_MANAGED grant;
4. persist license/grant in SQLite;
5. close and reopen durable security store;
6. authenticate through Customer API Gateway;
7. Customer Agent requests RECONNECT challenge;
8. Agent signs installation proof;
9. server authorizes AUTO exposure;
10. replay of the same activation proof is rejected;
11. grant is revoked;
12. subsequent AUTO fails closed;
13. fresh authenticated PAUSE remains available as a safety action.

## Excluded

- Master strategy logic;
- MT5 bridge;
- ARM mutation;
- LIVE mode mutation;
- order creation;
- position modification;
- LIVE test order.

## Acceptance

The dedicated CI must pass on the PR head and again on main before final handoff acceptance.
