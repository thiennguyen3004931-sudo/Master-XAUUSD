# P0 #176 — Gateway Restore Admission Integration Checklist

Status: REVIEW PLAN ONLY. Not a runtime security implementation. Customer Release #166 remains BLOCKED.

## Verified code seams

- `packages/customer-runtime-session/src/api-gateway.ts`: `CustomerApiGateway.handle()` accepts `/v1/customer/runtime/challenge` and `/v1/customer/runtime/activate`; existing grant/license/session checks are not sufficient to prove restored SQLite freshness.
- `scripts/customer-restore-authority-compare.mjs`: pure binding/high-water comparison, no independent authority transport.
- `scripts/customer-restore-authority-signed-proof.mjs`: pure Ed25519 proof validation with caller-supplied trust roots and nonce; not independent key lifecycle or durable revocation source.
- `.github/workflows/customer-restore-authority-proof-ci.yml`: explicitly executes both Node test suites; green unit tests do not demonstrate production integration.

## Mandatory integration requirements before any live gate change

1. Implement independently administered, durable monotonic authority outside customer-restorable media, with atomic updates and protected key rotation. Define availability, backup and recovery controls for the authority itself.
2. Define authenticated challenge/response transport; generate unpredictable fresh nonce per validation; pin public keys in operator-controlled non-restorable configuration. Never trust a key or high-water mark read from the restored SQLite or its backup.
3. Model a restore-quarantine state that blocks **both** challenge issuance and activation; prefer pre-listener startup admission and also require request/session authorization so no already-open listener can bypass it.
4. Bind authority proof to exact customer, installation, license, grant and epoch; compare generations; reject revoked license/grant, consumed challenge, stale audit and token generations. Deny on missing authority, timeout, malformed proof, key mismatch, stale nonce, clock anomaly or ambiguous state.
5. Keep `SELF_MANAGED` and `COPY_FOLLOWER` behavior symmetric. Avoid granting permissions based on a cached PASS after authority revocation; define bounded freshness and invalidation.
6. Test race: authority revoked between challenge and activation; restore of old SQLite+WAL; two concurrent restores; rollback of authority store; stale key reinstall; transport failure; all must fail closed.
7. Run isolated Windows host restore acceptance with controlled synthetic data and redacted audit evidence; separate release review and customer DEMO acceptance. No MT5 LIVE activation.

## Implementation order

A. Pure protocol and key lifecycle tests -> B. Independent durable authority with synthetic concurrency tests -> C. Quarantine/startup gate with fail-closed integration tests -> D. Customer session and token lifecycle tests -> E. Isolated restore acceptance and operator signoff.

**Do not** wire the current pure comparator into Gateway as a replacement for independent authority. A caller-provided `independentAuthority: true` flag is an assertion, not a security boundary. The signed-proof verifier's caller-provided trusted keys must be independently pinned and lifecycle-managed before any production use.

No BOT_MODE, ARM, REVERSAL AUTO LIVE lock, production bot execution or MT5 order behavior may change as part of this plan.
