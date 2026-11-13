# Customer DPAPI installation key — conservative NTFS ACL preflight

**Status: READ-ONLY preflight, not complete host acceptance or commercial release approval.**

This PR adds `customer-release/bin/audit-customer-key-ntfs-acl.ps1` and a reusable ruleset evaluator. The auditor does not open private key contents, change NTFS permissions, modify the registry, touch brokers or call MT5. It returns sanitized `PASS` or `BLOCKED`; it never prints user SID/account, file paths, key bytes or Windows ACL dumps to CI.

## Operator invocation on a separately controlled customer Windows machine

Run from the extracted customer release directory, under the *same Windows account/profile* that would later decrypt the DPAPI key:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\bin\audit-customer-key-ntfs-acl.ps1 -InstallationRoot .
```

The script checks only the `keys` directory and `keys/installation-private.dpapi` file. It refuses missing objects, legacy `installation-private.pem`, junction/symlink/reparse points, insecure ownership, any inherited ACL rules, any non-allowlisted allow principal, and missing explicit current-user read grants. Only the current account SID, local SYSTEM and built-in Administrators are allowed as direct ACL principals for this conservative policy. All unexpected errors return `BLOCKED`, exit code 2. **It never grants rights or attempts to repair permissions.**

### Meaning of the result

- `CUSTOMER_DPAPI_KEY_ACL_CONSERVATIVE_PREFLIGHT=PASS`: this particular conservative ruleset matched the observed DACLs for the folder and encrypted key file at the time checked.
- `CUSTOMER_DPAPI_KEY_ACL_CONSERVATIVE_PREFLIGHT=BLOCKED`: a condition could not be proven safe, including permission inheritance that may be legitimate but was not independently reviewed.
- `CUSTOMER_DPAPI_KEY_ACL_EFFECTIVE_HOST_ACCEPTANCE=NOT_VERIFIED` even on PASS: this policy **cannot prove** effective permissions in every Windows group membership, privilege, linked token, local administrator, offline backup or filesystem race scenario. Nor does it demonstrate data-at-rest encryption independently of the DPAPI loader.
- `CUSTOMER_RELEASE_APPROVAL=NOT_VERIFIED` always: a PASS here is not a license to deploy the bot, activate a product, trade or hand off a customer release.

The operator must obtain separate sanitized evidence of the actual host account, ACL inheritance, backup storage, recovery/reset profile behavior and customer approval. Do not commit customer identity files or put any customer ACL export containing account names in GitHub Issues or Actions.

## Automated regression (synthetic SID strings only)

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/test-customer-key-ntfs-acl.ps1
```

Runs as an isolated synthetic ruleset test in dedicated Windows CI. No real customer key path or host ACL is audited by this regression. This test is wired into both Private Master Core CI and Customer Deployment + Follower Read-Only Acceptance.

**Still-open P0 controls:** DPAPI identity lifecycle on actual customer Windows PC, approved migration of legacy unencrypted PEM, effective NTFS permissions and profile/backup protection, authorized release publisher and signed immutable package, revocation/recovery and independent pilot. Track these in [#169](../../issues/169) and [#166](../../issues/166). **No BOT_MODE, ARM, customer activation or MT5 orders are authorized.**

## Extra Windows positive-path integration regression (synthetic disposable fixture)

`node --test scripts/customer-offline-readiness-positive-windows.test.mjs` runs on the Windows CI runner under a temporary directory whose name is constrained to `xauusd-offline-positive-*`. The fixture generates an ephemeral Ed25519 private key, DPAPI-protects it under the runner's **current Windows user**, and applies a restrictive DACL **only to its own synthetic temporary folder/file** via `scripts/customer-offline-readiness-synthetic-acl-fixture.ps1`. The fixture refuses any path outside the Windows temporary directory and does not read private key file contents or touch any customer/production path.

The test requires the real offline readiness command to report `PASS` with restrictive synthetic ACLs, then requires `BLOCKED` when the fixture intentionally adds Everyone read access. It also checks a substituted public key causes `BLOCKED` without changing the DPAPI ciphertext. No Gateway, MT5, broker, license or real customer key is involved.

**Scope warning:** This improves confidence in the executable Windows path, but it is **not** a real-customer host ACL review, NTFS privilege/backup audit, profile recovery test, hardware compromise assessment or permission-remediation tool. Actual customer deployment remains blocked on separate evidence.

## Windows PowerShell 5.1 NTFS ACL interoperability

The production read-only `customer-key-ntfs-acl-policy.ps1` now obtains `DirectorySecurity` and `FileSecurity` via Windows .NET `FileSystemAclExtensions.GetAccessControl()` on modern runtimes, with a Windows PowerShell 5.1 / .NET Framework instance-method fallback when the extension API is unavailable. The original `Get-Acl` cmdlet was unavailable in the isolated Windows CI environment (`CommandNotFoundException`). This is a compatibility change **only to reading the same ACL**, not a reduced principal allowlist or permission inheritance check. Any unsupported API, access failure or invalid descriptor still produces `BLOCKED`.

The **test-only** disposable Windows TEMP ACL fixture uses the same version-aware .NET read API and applies ACL changes with native `icacls.exe` after a strict temp-directory/owner/reparse-point guard. Neither `Get-Acl` nor `.SetAccessControl()` is required by the fixture. Only the fixture writes ACLs; the shipped customer audit and offline readiness commands remain **read-only**. The positive/negative integration tests must demonstrate actual Windows execution before this change can be merged.
