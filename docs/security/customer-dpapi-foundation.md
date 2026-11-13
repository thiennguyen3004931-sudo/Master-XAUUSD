# Windows DPAPI CurrentUser — customer key-protection foundation

> **2026-10-26 integration addendum — PR #170 (unmerged):** The material below documents PR #167's original **foundation** status. PR #170 proposes wiring DPAPI into the new-installation generator and activation loader. This does **not** migrate any legacy PEM or certify effective NTFS ACL/Windows profile isolation. Code integration is only provisionally complete pending exact-head CI, and commercial release remains BLOCKED. See [#169](../../issues/169).

**Status: experimental foundation / NON-PRODUCTION.** This change does not migrate an existing identity, does not change the V1 installation generator or activation code, and does **not** close the commercial-release key-at-rest blocker in #166. No customer key was read or written to develop this code.

## Boundaries and rationale

- `customer-release/bin/windows-dpapi-key-vault.ps1` offers PowerShell 5.1 CurrentUser DPAPI Protect/Unprotect. The caller gives base64 input over an anonymous local stdin pipe and receives base64 output over stdout. The script never accepts a private key on the command line, makes network requests or writes any file.
- `customer-release/bin/windows-dpapi-key-vault.mjs` is a Node 24 Windows-only wrapper. It accepts `Buffer`, uses a versioned `XAUUSD_DPAPI_CURRENT_USER_V1:` prefix for ciphertext and rejects unknown versions, malformed base64, failed PowerShell operations and non-Windows environments. The wrapper intentionally suppresses PowerShell stderr because system crypto errors may expose host details.
- The DPAPI entropy is public domain separation, **not a substitute for account authentication or an encryption secret**. DPAPI CurrentUser ties unprotect ability to the same Windows security principal/profile and its DPAPI master-key protection. It does not resist code execution with that user's rights, local administrator compromise or a compromised host; admins also control machine state and may have recovery options.
- Unprotect necessarily returns plaintext into Node process memory via a local child stdout pipe. Applications must immediately use and then zero mutable plaintext Buffers where practical, never log raw payloads, and avoid exposing child output in exception messages.
- No plaintext PEM file is removed by these helpers. The current V1 generator still uses `installation-private.pem`, and current activation still reads that PEM directly. Do not label the customer installation protected on the basis of this library alone.

## Automated acceptance (synthetic inputs only)

`node --test scripts/customer-windows-dpapi-foundation.test.mjs`

The test generates random ephemeral bytes in memory and verifies DPAPI CurrentUser round-trip, versioned ciphertext and tamper rejection without creating customer identities, reading any production paths, accessing MT5 or persisting runtime secrets. Non-Windows platforms test the fail-closed refusal; the Windows-only part must actually PASS on the approved self-hosted Windows runner. Both Private Master Core CI and Customer Deployment + Follower Execution Acceptance run the test.

## Required before any live customer identity migration

1. Design crash-consistent creation of encrypted identity, public key and installation ID without ever persisting unencrypted private PEM; detect partial state and refuse silent regeneration.
2. Design an **explicit** legacy PEM migration requiring an operator-owned maintenance window: validate public/private match first, write encrypted output exclusively, verify it, then clean up plaintext with appropriate filesystem controls. Do not presume ordinary file deletion securely erases SSD history or backups.
3. Update customer activation to decrypt only the versioned protected identity on the correct Windows user; reject unsupported, partial or downgraded identity storage. Adjust the distributed config and packaging policy to forbid legacy plaintext paths.
4. Validate effective Windows ACL inheritance for all generated key material, temporary files, profile access and backup access on an actual separately controlled Windows customer PC.
5. Test wrong Windows user/profile, missing or corrupt encrypted blob, interrupted migration, account restoration, new-PC recovery, granting/revoking licenses and token hygiene with fake customer identities. Windows profile reset may make DPAPI CurrentUser data permanently unreadable.
6. Obtain human security review, sign the release with a separately trusted publisher key, and run independent customer-machine pilot acceptance before distribution.

**Trading boundary:** this foundation cannot switch BOT_MODE/ARM, connect to the customer or Master bridge, submit broker orders, or authorize DEMO/LIVE trading. Any subsequent integration must remain in a separately reviewed branch and pass exact-head CI before merge.
