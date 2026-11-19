# Operator-side token lifecycle ledger — synthetic acceptance

**Security status: integration component only; not an accepted production service.** Relates to P0 #176 and customer release blocker #166.

## Why this exists

The existing `Sha256CustomerApiKeyAuthenticator` receives a static list of hashes at process start. A token revoked later is still recognized by that instance. The new `LedgerCustomerApiKeyAuthenticator` resolves the latest hash record per request, and rejects a revoked/expired identity or unavailable ledger. This module provides a testable operator-owned SQLite implementation of that ledger.

## Code boundary

- `packages/customer-runtime-session/src/operator-token-ledger.ts` provides `initializeEmptyOperatorTokenLedger()` (explicit empty enrollment, never auto-create at Gateway startup), `registerToken()` (new hash only), `revokeToken()` (compare-and-swap generation, irreversible for that hash), `rotateToken()` (single SQLite transaction; 0–60 second overlap with new hash), `getBySha256()`, and `close()`.
- The operator token SQLite file **MUST** be placed on independently administered storage outside the customer-installation and restorable customer SQLite+WAL/SHM snapshot scope.
- No plaintext bearer token is persisted in the ledger. Tokens MUST be cryptographically random, high entropy and distributed through a secured enrollment channel; no secret or real customer record belongs in CI.
- A new token for rotation receives a NEW digest with its own bounded expiration; do not extend or reactivate a revoked digest.
- The token ledger's on-disk state requires its OWN authenticated monotonic rollback defense. A writable local SQLite file alone does **not** prevent privileged rollback or data loss, even when outside the customer's backup. Do not treat local file mode `0600` as Windows NTFS effective ACL verification.
- The class does not create a network service, admin role authorization, TLS, key management, encrypted backups, operator audit approvals, replication, secure recovery, or a production Gateway bootstrap.
- For production deployment, approved provisioning must pin external authority/trust roots, validate effective host and backup ACLs, require dual-operator review for revocation/reset, and enforce an independently monotonic revoke ledger before enabling customer access.

## Safety and negative acceptance

Synthetic vitest cases cover initial token admission; duplicate token denial; expiration; restart; cross-reader revocation immediately visible; stale generation CAS conflict; revoked hash cannot be re-created; separate customer-restore copy cannot rewrite operator-store token state; unavailable/corrupt store fail closed; atomic zero/short-overlap token rotation and transaction rollback on stale-generation or customer mismatch.

Fast GitHub-hosted checks run on Node 24 for security-package build, TypeScript and synthetic token/Gateway regressions. The Windows customer-host and exact-main gates remain separately mandatory.\n\nThis does NOT implement the separate restore authority for customer license/grant/challenge generations, secure WAL-consistent encrypted backup, or signed production release. Issue #176 and #166 remain OPEN. No BOT_MODE, ARM, REVERSAL AUTO LIVE, MT5 bridge or customer host state changes.
