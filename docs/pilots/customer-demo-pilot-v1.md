# Customer Pilot V1 — SELF_MANAGED and COPY_FOLLOWER

Status: **prepared for controlled customer-machine testing**, not executed on a customer Windows host by this PR. The CI customer E2Es are software/simulated. This plan does not authorize any real or DEMO order.

## Pilot environment and isolation

- Use a physically/logically separate Windows PC/VPS and **separate broker MT5 DEMO accounts**, never a Master production account or Master control bridge.
- Verify Node.js 24, approved exact artifact SHA, Windows user identity and access control, time sync, package manifest, licensed installation ID and gateway TLS.
- Explicit operator/customer consent and host-level sign-off required for each pilot. The Master private strategy source and signing private keys are not distributed.
- First activation SELF_MANAGED remains `PAUSE`. COPY_FOLLOWER must not connect an execution-capable adapter until separately approved for DEMO.
- Collect sanitized observations only; never export keys, passwords, bearer tokens, broker secrets or full environment logs.

## Test sequence and evidence

| Phase | Test | Must prove |
| --- | --- | --- |
| P0 — Offline verification | Verify outer/inner ZIP digests, manifest, code-signing identity if deployed, source SHA | Exact artifact; reject tampering |
| P1 — Identity and gateway | Generate once; enroll; connect with HTTPS; reject wrong token, installation/account/broker, wrong product mode | Fail-closed grants |
| P2 — SELF_MANAGED PAUSE | Activate on new customer machine without changing Master runtime | Server authorization only; no order or ARM |
| P3 — Revoke/recovery | Revoke installation, restart service, deny old proof, migrate to new PC with new keypair | Old credentials remain unusable and audit survives |
| P4 — COPY_FOLLOWER verifier | Deliver fake/signed canonical events to an injected mock executor; reject replay, out-of-order and cross-customer commands | No broker side effects |
| P5 — MT5 DEMO connectivity, **separate approval required** | Read-only health, account/broker/symbol/volume/position reconciliation | Exact DEMO identity, no mutation |
| P6 — MT5 DEMO execution, **not authorized in this change** | If separately approved later: minimal volume open, SL protection, partial close, trailing, reconnect/reconcile, duplicate prevention | Evidence for each broker-confirmed lifecycle |
| P7 — Failure exercises | Network loss, process crash, stale bridge, clock drift, duplicate messages, invalid quote, broker rejection | No unbounded exposure, no duplicate or unauthorized execution |
| P8 — Operator sign-off | Record exact scope, evidence, blockers, rollback and sign-offs | Explicit RELEASE/BLOCK decision |

For any P5/P6 follow-on, the owner must explicitly approve the intended DEMO account, broker and risk budget and verify a flat state, unless the plan explicitly covers existing exposure. Do **not** reuse Master production login or attempt LIVE ARM.

## Exit criteria

- No unresolved high-severity security or execution defects.
- Exact artifact provenance/signature and host access controls verified.
- Each planned scenario has PASS/FAIL/BLOCKED evidence; simulated CI never substitutes for broker confirmation.
- No duplicate orders, unauthorized copy commands, risk-increasing SL moves, or failure to reconcile positions.
- Sign-offs recorded and pilot release remains DEMO-only until a different authorized LIVE process.

## Local acceptance template

Use `customer-release/acceptance-record.template.md`, add pilot ID, machine identifier (masked), broker DEMO server, simulated/real test distinction, unique trade references (masked) and incident/rollback outcomes in the **restricted** customer record system. Do not commit completed customer records.
