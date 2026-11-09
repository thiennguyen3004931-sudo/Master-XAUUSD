# Customer Delivery V1 — operator runbook (VI)

**Current status: BLOCKED for commercial customer distribution.** This is a release procedure, not an acceptance certificate or permission to enable LIVE trading.

## Product packages

- **SELF_MANAGED**: customer holds a separately issued installation identity and may control only the administrator-approved bot modes on their own machine. First acceptance remains PAUSE; no automatic LIVE execution or change of Master BOT_MODE/ARM.
- **COPY_FOLLOWER**: follower verifies signed command provenance, its customer/account/grant binding, sequence and replay protection. The current package does not constitute an independently accepted real MT5 bridge; injected-executor CI is synthetic.

The release must never contain Master strategy source, publisher private signing keys, customer bearer tokens, broker credentials, a working Master control bridge or unredacted customer-specific data.

## Automated engineering checks

1. Code changes on a feature branch, with exact-head PR tests including canonical, private-core, customer API, both product modes, migration and security boundaries.
2. Latest accepted **main** SHA must match the actual candidate artifact SHA. Re-run the exact-main customer handoff and private-core CI; old green results are invalid for a new SHA.
3. The workflow **Customer Release Readiness Evidence (Not Authorization)** generates a machine-readable BLOCKED report. It checks GitHub issue #166/#176 state and selected exact-SHA workflows; it cannot attest real host acceptance, publisher trust or operator release approval. A green *report job* is not a green *release authorization*.
4. Validate inner customer ZIP file manifest, outer GitHub artifact digest, unexpected/excluded files and reproducible source provenance.
5. Verify detached Ed25519 signature using an independently approved, pinned publisher key; if trust is not enrolled or signature absent, label UNSIGNED_RC_NOT_FOR_CUSTOMERS.

## Mandatory security and operational approval

1. Resolve P0 #176: independently controlled monotonic authority, fail-closed Gateway, rollback of revoked licenses/grants/challenges/tokens, key rotation and persistence, crash-safe encrypted backup/restore.
2. Validate key ownership, Windows CurrentUser DPAPI and effective NTFS ACL on a physically separate Windows pilot. No real customer private-key migration or security-database restore without separately authorized change window.
3. Complete SELF_MANAGED pilot with customer grant/account/broker binding, negative authorization scenarios, initial PAUSE, restart and revocation.
4. Complete COPY_FOLLOWER pilot with signed replay-resistant mock flow first; any broker DEMO read-only binding and eventual DEMO order execution require distinct operator approvals. Never enable LIVE ARM through customer acceptance.
5. Record operator/customer sign-offs, incident response and secure rollback artifact in an access-controlled record. Do not commit completed customer records.

## Final decision

- **CANDIDATE / software tested:** GitHub CI and local synthetic E2E pass for the exact commit; distribution not authorized.
- **BLOCKED:** any unsigned candidate, open P0, missing Gateway enforcement, unavailable trusted authority, expired token, incomplete host/pilot evidence or missing explicit approval.
- **APPROVED_FOR_SPECIFIC_CUSTOMER_AND_SCOPE:** only a separately verified signed artifact with documented independent operator approval, customer host/identity binding and mode-specific acceptance. This document alone cannot grant this status.

Do not change BOT_MODE, ARM, REVERSAL AUTO LIVE lock or send MT5 orders as part of release engineering.
