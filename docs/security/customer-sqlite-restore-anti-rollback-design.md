# P0 Customer Security SQLite Restore — Anti-Rollback Design and Test Witness

Status: **DESIGN / SYNTHETIC EVIDENCE ONLY — RESTORE NOT APPROVED**.
Owner tracking: [Issue #176](../../issues/176), release blockers [#166](../../issues/166).
Accepted baseline at start of this work: `main@b880a5f90704dad7130966000f01220ce5ab6091`.

## What the current code guarantees — and what it cannot

`SqliteCustomerLicenseRepository.put()` now uses an atomic live-database
transaction to reject a stale `ACTIVE` write over an existing `REVOKED`
license (PR #177). Grant compare-and-set also prevents a stale revision from
overwriting a newer revision **in the same active database**.

This does NOT protect a restored physical SQLite file that was copied when
licenses and grants were still ACTIVE. An old database can contain valid
historical signatures, hashes and even an internally consistent audit log,
but still be missing subsequent revocations, challenge consumption or token
rotation. A package SHA-256, GitHub CI success, or a successful SQLite
`PRAGMA integrity_check` is not an independent revocation witness.

The synthetic regression
`packages/customer-runtime-session/src/sqlite-store.test.ts` explicitly
demonstrates old-backup state holding ACTIVE license/grant despite a later
REVOKED state in the original database. **Passing that test means a known
unsafe restore condition was reproduced. It does not mean restore is safe.**

## Required independent trust boundary

A future restore validator must require an independently authenticated,
monotonic revocation/high-water-mark authority that:
1. Is stored outside the SQLite DB, outside all backups of that DB, and
   cannot be rolled back with a copied install folder or customer ZIP.
2. Authenticates publisher/operator identity and binds to installation,
   customer, license, grant, revocation generation and source version without
   exposing private keys or raw bearer tokens.
3. Rejects a candidate snapshot with lower generation or missing revocation,
   consumed challenge or token-revocation state. An unknown or unavailable
   authority means **BLOCKED**, not an offline allow.
4. Detects attempts to reset the ledger, replay a previously valid signature,
   swap customer identities or reinstall old trusted-key material.
5. Requires an authorized and independently audited reissuance/migration
   rather than silently changing a revoked identity back to ACTIVE.

A signed manifest **inside the same backup** is insufficient by itself:
an attacker can replay that manifest together with the older database.

## Controlled restore acceptance sequence (not implemented)

- Record explicit owner/operator authorization; restrict work to an isolated
  Windows recovery host and synthetic customer references until approved.
- Quiesce writers and create a consistent SQLite snapshot using a supported
  SQLite backup API or other WAL-consistent mechanism. Never assume copying
  only `.sqlite` while WAL is active is safe.
- Encrypt the archive at rest with a separately managed and recoverable key;
  validate access restrictions, digest, version and retention policy.
- Read and authenticate the independent revocation authority *before*
  opening any Gateway listener, accepting any customer token or granting a
  runtime session.
- Compare all restored records and challenges with the authority. Refuse
  any missing proof, stale epoch, replay, revoked grant/license reactivation
  or consumed challenge resurrection. Retain only sanitized PASS/BLOCKED
  evidence; no secrets or customer-specific paths in issues or CI logs.
- Validate expiry/revocation of API tokens with a durable independent
  lifecycle. A static list of token hashes is not an expiry/rotation policy.
- Require independent operator sign-off plus separate customer-host / MT5
  DEMO acceptance. No LIVE/DEMO trade is an automatic restore test.
- Keep a documented rollback that returns to a securely blocked state, not
  to any prior ACTIVE authorization.

## Why the current regression is deliberately limited

The new test copies a **closed disposable synthetic** SQLite DB before
revocation, revokes license/grant in the original, and independently opens
the old copy to prove it still holds ACTIVE state. It never restores a
production file, runs a Gateway, accepts real customers, prints private
identities or mutates BOT_MODE, ARM or MT5. The synthetic in-memory
comparison is **not** a durable, independently authenticated authority.

P0 #176 must stay OPEN until a real fail-closed restore protocol and
independent trust root have been reviewed, implemented and tested, including
actual recovery proof on an authorized isolated host.
