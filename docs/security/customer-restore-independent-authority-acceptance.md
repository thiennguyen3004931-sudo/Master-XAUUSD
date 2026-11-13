# P0 #176 — Independent Restore Authority: Implementation and Acceptance Contract

Status: **DESIGN / REVIEW ONLY**. No production restore, no trust-root deployment, no customer activation.

## Security boundary

The SQLite runtime database, its WAL/SHM, install folder, encrypted archive and any manifest bundled with the archive are **untrusted candidate state** on restore. A checksum, signed manifest stored in the same archive, SQLite integrity check, or green CI result cannot establish freshness.

Before a customer Gateway binds a listener or a session is authorized, a separately controlled and authenticated authority MUST return a fresh, monotonic high-water statement for the exact customer, installation and license/grant binding. The authority and its signing key MUST be outside customer-restorable storage. If it cannot be contacted, authenticated, or its freshness cannot be established, the only permitted result is **BLOCKED**.

## Minimum authority statement (versioned schema proposal)

- `schemaVersion`, `authorityKeyId`, `issuedAt`, `expiresAt`, unpredictable `requestNonce` bound to the current validation request.
- Canonical `customerId`, `installationId`, `licenseId`, `grantId`, and `bindingEpoch`; use stable opaque IDs, never raw tokens.
- Monotonic `revocationGeneration`, `migrationGeneration`, `challengeConsumptionGeneration`, `auditHighWater`, `tokenGeneration`.
- Explicit current authorization state (including revoked/expired), not just a hash of the snapshot.
- Authenticated signature over a canonical serialization with domain separation and key-rotation policy. Pin an operator-controlled trust root outside the backup; reject stale, unknown or revoked keys.
- The authority MUST enforce monotonic updates atomically, prevent rollback/reset of its own ledger, and retain durable revocation history.

This is a contract proposal, not a claim that these fields or controls already exist.

## Restore admission gate

1. Enter quarantine; no API listener, session, copy follower, SELF_MANAGED executor or MT5 order path.
2. Authenticate operator approval and obtain a consistent SQLite snapshot with SQLite backup API or verified WAL checkpoint; do not copy an active `.sqlite` alone.
3. Verify archive integrity, encryption and recovery key authorization. These are necessary but **not** freshness proof.
4. Issue a fresh nonce to the independent authority; verify identity, signature, key status, nonce, expiration and complete binding tuple.
5. Compare restored license/grant status and all five generations against independent authority. Any lower, absent, ambiguous, or conflicting value => BLOCKED.
6. Reject resurrected revoked licenses/grants, consumed challenges, missing migration audits and replayed/expired/revoked tokens, even when their historical signatures are valid.
7. Log only sanitized decision codes and non-secret evidence. An approved reissue must use a new binding and independently audited operator authorization.
8. Permit service startup only after a separate reviewed release gate; a PASS here is **not** permission to enable AUTO, ARM or trading.

## Deterministic acceptance matrix

| Synthetic scenario | Expected decision |
| --- | --- |
| Matching latest generation, valid nonce/signature and active binding | Eligible for *further* gates, not auto-activate |
| Pre-revocation physical SQLite copy | BLOCKED |
| Pre-migration copy with formerly unconsumed challenge | BLOCKED |
| Missing independent authority / network timeout | BLOCKED |
| Wrong customer, installation, license or grant tuple | BLOCKED |
| Replayed signed authority response / wrong nonce / expired statement | BLOCKED |
| Unknown, retired or revoked signing key | BLOCKED |
| Authority generation below previously witnessed high-water | BLOCKED |
| Old token after rotation or revocation | BLOCKED |
| Corrupt archive, incomplete WAL snapshot or unapproved recovery key | BLOCKED |

## Engineering sequence

- **A:** Define versioned canonical statement and strict verifier, with pure synthetic negative tests; no Gateway integration.
- **B:** Implement separately administered durable monotonic authority and key lifecycle; include concurrent-update and disaster-recovery tests.
- **C:** Integrate fail-closed admission before Gateway/session start; prove no bypass in SELF_MANAGED and COPY_FOLLOWER.
- **D:** WAL-consistent encrypted backup/recovery and token rotation/expiry; isolated host acceptance, audit, rollback-to-BLOCKED.
- **E:** Independent security review and explicit operator release authorization. Keep issue #176 and parent #166 OPEN until all acceptance evidence exists.

## Operational invariants

No change to BOT_MODE, ARM, MT5 orders, production startup, runner services, real customer databases or secrets. AUTO LIVE REVERSAL new-entry hard lock remains in force. Do not use a synthetic PASS to approve Customer Release V1.

## Synthetic dual-proof witness review (2026-11-03)

`scripts/customer-restore-independent-witness-guard.mjs` is a pure, **non-operational** second-proof comparison. It verifies an already fresh signed operator statement against a fresh signature from a *different Ed25519 key*, and requires both the operator and witness keyrings to match separately provided trusted SHA-256 fingerprints and pinned epochs; signer revocation and validity windows are checked. The witness represents an independently stored monotonic high-water reference, but that independence is an external operational requirement, not a property created by this code. It deliberately returns `customerAuthorizationAllowed: false` even on matching evidence. Synthetic tests demonstrate that restoring BOTH an old customer SQLite and an old operator authority file (a case the single proof accepts) is detected when the separately held witness has a later revoke/audit generation; they also exercise challenge/token/migration rollback, identity swap, wrong root, nonce replay, expiration and same-key alias.

**This code DOES NOT provide the trusted external witness.** Two different keypairs do not establish separate administration, irreversibility, availability or non-rollbackable storage; an old *witness file and its signatures* can still be replayed together if the trusted monotonic checkpoint is itself restorable. Production must pin the independent key and highest observed epoch/counter to a separately authorized and non-restorable KMS/HSM/operator trust domain, atomically advance that checkpoint, authenticate all transport, enforce fail-closed Gateway pre-listener/session quarantine, and obtain human acceptance. Never wire the synthetic comparator directly to production startup or treat its test PASS as authorization.

## Monotonic high-water checkpoint supplement (2026-11-04)

The synthetic dual-proof comparator now additionally requires a `trustedWitnessCheckpoint`
whose exact binding tuple, five monotonic generations, authorization state and
witness signing-key epoch can be checked against the fresh signed witness.
**This is a pure comparison, not a trust-anchor implementation.** An absent,
malformed, wrong-binding, lower-generation, lower-epoch or previously revoked/
expired checkpoint rejects with a sanitized reason code. All results retain
`customerAuthorizationAllowed: false`.

A key security regression demonstrates that **two new, correctly signed proofs
over the same OLD state** can agree with each other. A newer, independently held
high-water floor still detects the rollback. If that floor is also rolled back,
the comparison may report synthetic agreement; therefore the system must
independently authenticate the checkpoint and atomically persist its monotonic
advance outside every customer/operator/witness backup scope before any
Gateway/session admission. Storing a user-provided checkpoint, keyring digest
or pinned epoch in a restorable file is **not** production protection.

A real accepted design still requires a separately administered durable authority
or KMS/HSM, recovery and compromise playbook, protected transport and key
rotation, fail-closed pre-listener Gateway quarantine, Windows ACL/DPAPI review,
independent audit, and explicit customer-host release sign-off. #176 and #166
remain **OPEN/BLOCKED**; there is no real customer backup, access or MT5 action.

## Separate signing purposes (2026-11-04, synthetic code only)

Operator authority assertions are signed with the fixed domain `XAUUSD-CUSTOMER-RESTORE-AUTHORITY-V1`, while independent high-water witness assertions now require `XAUUSD-CUSTOMER-RESTORE-WITNESS-V1`. Both use the existing canonical field sequence, with explicit fixed-purpose issuers/verifiers and the previously required pinned signer keyring+epoch validation. A witness-domain signature must not validate as an operator authority proof, and an operator-domain signature must not validate as a witness, even if the signature comes from a formally trusted key. Synthetic cross-domain replay tests cover both directions. The independent witness comparator continues to return `customerAuthorizationAllowed: false` even on a matching proof pair.

This cryptographic purpose separation **does not** implement independently administered key custody, non-rollbackable high-water storage, authenticated witness retrieval, pre-listener Gateway quarantine or live customer activation. No production proof format is migrated or issued by this PR. #176 and #166 remain release blockers.
