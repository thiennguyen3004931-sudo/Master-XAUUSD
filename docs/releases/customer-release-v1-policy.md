# Customer Release V1 — distribution and rollback policy

Status: **release candidate policy**, not an authorized LIVE trading release. Product modes: `SELF_MANAGED` and `COPY_FOLLOWER`. The shipped `customer-agent-v1.zip` contains neither proprietary Master source nor a usable customer MT5 execution bridge.

## Immutable release checklist

1. Select a reviewed `main` SHA and record its public contract lock.
2. Require Canonical Gate, Private Master Core CI and every relevant customer E2E/package workflow to PASS on the accepted change set. Record each run and SHA.
3. Build a customer package with exact dependency lock; require clean ZIP extraction, manifest SHA-256 verification, missing/extra-file rejection and zero private Master sources/credentials.
4. Download the GitHub artifact through an authenticated approved process. Hash **outer GitHub artifact archive** and **inner customer ZIP** separately. Compare outer digest with GitHub metadata, verify every inner manifest entry, and retain immutable masked evidence.
5. Create a release identifier (for example `customer-agent-v1.0.0-rc1`) and a detached attestation binding source SHA, public contract, inner ZIP hash, signer ID and release time. This shared ZIP supports both `SELF_MANAGED` and `COPY_FOLLOWER`; **the attestation does not authorize or bind an individual customer's product mode**. Product-mode authorization belongs to the separately validated per-installation license/grant. Signing private key must be provisioned outside GitHub, repository, customer ZIP and logs. Signature verification code and trusted public-key IDs may be distributed.
6. If signature infrastructure is absent, classify status `UNSIGNED_RC_NOT_FOR_CUSTOMERS`; a SHA-256 alone checks integrity against a trusted digest but does **not** authenticate the publisher. Do not assert signature PASS.
7. Release metadata must specify artifact retention expiry, known limitations, approved installation path, help/support, security incident escalation, and explicit DEMO/LIVE permission boundaries.
8. Each customer has their own installation identity, licensed grant, broker/account binding and **blank completed-on-site** acceptance record; never fill customer-specific tokens/keys into this repo.
9. Approve a customer for DEMO only after separate local-machine acceptance. LIVE requires a new explicit risk and operational go/no-go decision.

## Release signature tooling (offline, candidate only)

Source: `scripts/security/customer-release-attestation.mjs`.
The signer uses Ed25519 and cryptographically binds the exact **inner customer ZIP bytes**, release ID, full accepted source SHA, full public contract SHA, UTC signing timestamp, and signer key ID. The verifier rejects unrecognized signers, modified ZIPs, malformed signatures and altered metadata.

**Trust bootstrap:** `security/customer-release-trusted-signers.json` ships with an empty `signers` array intentionally. This means every actual verification returns `RELEASE_SIGNER_NOT_TRUSTED` until a separate approved publisher public key is enrolled and independently authenticated. Do not copy a customer-supplied keyring as if it were trusted. Changes to the official trusted keyring require a reviewed PR and separately confirmed key fingerprint; never include its associated private key in a repository, artifact, chat, or support log.

Example: after an approved operator securely provisions an Ed25519 signer **outside the repository and customer machines**, sets the process-only `XAUUSD_RELEASE_SIGNING_KEY_FILE` to the protected private PEM path, and independently validates the exact accepted SHA:

```powershell
node scripts/security/customer-release-attestation.mjs sign --zip artifacts/customer-agent-release/customer-agent-v1.zip --out artifacts/customer-agent-release/customer-agent-v1.attestation.json --release-id customer-agent-v1.0.0-rc1 --source <accepted-40-hex-main-sha> --public <approved-40-hex-public-contract-sha> --key-id <approved-publisher-key-id>
```

Then verify against an **independently trusted** pinned signer-keyring (the repository default remains empty until enrollment):

```powershell
node scripts/security/customer-release-attestation.mjs verify --zip artifacts/customer-agent-release/customer-agent-v1.zip --attestation artifacts/customer-agent-release/customer-agent-v1.attestation.json --expected-release-id customer-agent-v1.0.0-rc1 --expected-source <independently-approved-40-hex-main-sha> --expected-public <approved-40-hex-public-contract-sha>
```

The verification command **does not accept `--trust` overrides**. It loads the repository-pinned public-key list; that list itself must be independently authenticated to the reviewed accepted repository revision. Release ID and SHA expectations must be obtained from an approved release decision outside the untrusted candidate attestation, not copied from it. The CLI reports separate signature validity, expected identity match and `CUSTOMER_RELEASE_CUSTOMER_ACCEPTANCE=NOT_VERIFIED`. A valid signature is **not** a commercial-distribution or trading approval.

A successful signature verifies who signed the ZIP and exact bytes **relative to the trusted keyring**; it does not prove the customer installation, MT5 bridge or trading correctness. Separately check GitHub's **outer** artifact archive digest, ZIP contents against `release-manifest.sha256`, forbidden paths, and actual Windows install. Signing must happen in an isolated authorized release step, **not** automatically from a PR test runner. The signing script refuses to overwrite an existing attestation. Tests use ephemeral synthetic keys only.

## Rollback

- Retain last verified signed package and public verification key; downgrade requires security compatibility and a new approved grant/session check.
- Do not restore an expired/revoked customer grant or reuse a retired installation key in rollback.
- For failed installation, restore only approved binaries/config (never move private keys between PCs), keep SELF_MANAGED at PAUSE, and re-verify exact account/broker/license.
- For COPY_FOLLOWER, require verified broker position reconciliation and no duplicate order on restart before resuming any execution. Never assume a failed HTTP acknowledgement means the broker rejected a trade.
- Preserve sanitized audit and rollback evidence. Do not roll back Master BOT_MODE/ARM or active trade management from a customer-agent package.
- Any package replacement changes SHA and requires a new evidence record. No mutable `latest.zip` alias as sole provenance.

## Release gates

| Gate | Owner and evidence | Status as of initial assessment |
| --- | --- | --- |
| Code/test/CI candidate | PR URLs, exact PR head SHA and jobs | PR #165 5/5 PASS on `c38939eb533c1043dd6345ee989138167819c9af` (2026-10-26); refresh after every commit and on accepted `main` |
| Digest and internal manifest | Two independent hashes, full file list | Historical artifact ID `12601917570` independently verified: outer SHA-256, inner ZIP SHA-256, 21/21 internal entries (2026-10-26); refresh for any new release |
| Cryptographic release signature | Trusted verification, signature ID and detached signature | Tooling implemented and synthetic tests PASS in PR #165; publisher keyring **empty**, no real signed artifact or authenticated publisher enrollment: BLOCKED |
| Real customer SELF_MANAGED | Separate Windows machine acceptance + sign-off | NOT VERIFIED |
| COPY_FOLLOWER on MT5 DEMO | Segregated and explicitly approved broker demo E2E | NOT VERIFIED |
| Production LIVE | Separate approval and risk gating | NOT AUTHORIZED |

No release is declared final in this document. No BOT_MODE / ARM / MT5 / position / order changes.
