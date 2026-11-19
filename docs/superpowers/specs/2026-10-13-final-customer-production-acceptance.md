# Final Customer Production Acceptance

## Completion definition

Customer handoff is complete only when this final read-only workflow passes on the final main SHA and the repository's Canonical PR Gate and Private Master Core CI also pass for the corresponding accepted change set.

## Mandatory chain

The final gate validates:

1. copy protocol;
2. license service;
3. installation proof;
4. customer product access;
5. customer grant registry/admin;
6. customer activation;
7. runtime gate;
8. durable runtime session/security store;
9. authenticated/rate-limited API gateway;
10. customer agent distribution boundary;
11. SELF_MANAGED E2E;
12. COPY_FOLLOWER E2E;
13. signed copy command binding/replay protection;
14. revoke/new-PC migration;
15. restart recovery;
16. persistent migration audit.

## Customer delivery modes

### SELF_MANAGED

Customer authenticates, proves installation identity, and requests only server-authorized bot modes. Master trading source is not distributed by the customer agent.

### COPY_FOLLOWER

Customer authenticates as a follower, receives only the authorized copy product flow, and validates signed canonical copy commands locally before any downstream execution integration.

## Final safety boundary

This acceptance is read-only/simulated with respect to production trading.

It does not:

- ARM the Master bot;
- enable AUTO on production;
- change production BOT_MODE;
- place/modify/close a LIVE order;
- modify a LIVE position;
- issue a LIVE test order;
- perform a production trading cutover.

## Final PASS evidence

Final handoff requires:

- this workflow = success on main;
- Canonical gate = success;
- Private Master Core = success;
- no stale/duplicate active run masking the accepted SHA;
- final main SHA recorded in the acceptance report.
