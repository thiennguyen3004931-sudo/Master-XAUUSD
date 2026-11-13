# Customer COPY_FOLLOWER E2E Acceptance

## Goal

Prove the COPY_FOLLOWER customer handoff path through authentication, activation, signed command verification, binding, sequence, and replay controls without executing any MT5 trade.

## Covered flow

1. create installation identity;
2. create customer license and COPY_FOLLOWER grant;
3. persist server-side license/grant;
4. authenticate Customer Agent through the gateway;
5. activate the allowed EQUITY_RATIO sizing mode;
6. reject a bearer token bound to a different customer;
7. sign a canonical copy command with the Master copy signing key;
8. validate trusted key ID and Ed25519 signature;
9. validate license / installation / MT5 login / broker / symbol binding;
10. accept a valid command once;
11. reject exact replay;
12. reject command for another installation;
13. enforce monotonic sequence in verifier unit tests.

## Execution boundary

Acceptance stops at signed command ACCEPTED/REJECTED.

It does not invoke:

- MT5 bridge;
- order send;
- position open/close;
- stop-loss modification;
- Master bot mode;
- ARM.

## Acceptance

The dedicated COPY_FOLLOWER E2E workflow and the overall Customer Handoff Production Acceptance must both pass on the current head and on final main.
