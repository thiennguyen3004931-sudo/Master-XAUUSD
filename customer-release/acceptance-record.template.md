# Customer Installation & Handoff Acceptance Record

Use one copy per customer installation. This record is for sanitized operational evidence only; **never record bearer tokens, passwords, private keys, full environment dumps, or unmasked account secrets**. Store completed records only in the approved access-controlled customer record system, not in this repository.

Status values: `PASS`, `FAIL`, `BLOCKED`, or `N/A`. Explain every `FAIL`, `BLOCKED`, and `N/A`.

## 1. Package evidence for this installation

This is a blank acceptance record. No package, checksum or customer installation has been verified by this template. Fill in every field from the exact approved package being handed over and retain the corresponding verification evidence. Do not copy values from an older artifact or mark these checks as passed based on the presence of this file.

| Field | Value to verify and record |
|---|---|
| Package version | `[version from package.json]` |
| Source commit | `[full SHA from the accepted main workflow run]` |
| Workflow run | `[run ID and URL]` |
| GitHub artifact ID | `[artifact ID from that run]` |
| GitHub artifact name | `[artifact name from that run]` |
| GitHub artifact archive SHA-256 | `[verified outer archive SHA-256]` |
| Downloaded customer ZIP SHA-256 | `[verified inner customer ZIP SHA-256]` |
| Customer ZIP internal manifest | `[verified entry count and checksum result]` |
| Artifact expiry | `[expiry date/time and timezone, or N/A with reason]` |
| Official GitHub Release | `[release URL, or CI artifact only]` |

The two SHA-256 values refer to different files: the GitHub Actions artifact archive and the downloaded customer package ZIP. Do not interchange them. Verify the checksum of the exact file received before extraction. The inner ZIP hash identifies the package contained inside the downloaded outer artifact archive.

## 2. Customer and installation scope

- Customer reference (non-secret): `[fill in]`
- Handoff ticket/reference (no credentials): `[fill in]`
- Delivery mode: `[SELF_MANAGED / COPY_FOLLOWER]`
- Installation ID: `[fill in after generating on customer machine]`
- Grant/license reference (ID only): `[fill in]`
- MT5 login: `[masked; e.g. ****1234]`
- Broker server: `[fill in approved server label]`
- Gateway host (HTTPS only; no query strings or tokens): `[fill in]`
- Customer machine / operator reference: `[fill in]`
- Acceptance date/time and timezone: `[fill in]`

Do not attach the installation private key. The private key must remain on the machine where the identity was generated.

## 3. Installation and security checks

| Check | Status | Evidence reference / sanitized note |
|---|---|---|
| Received ZIP checksum matches the approved package | `[PASS/FAIL/BLOCKED/N/A]` | `[fill in]` |
| Package extracted on the intended Windows machine; Node.js 24.x confirmed | `[PASS/FAIL/BLOCKED/N/A]` | `[fill in]` |
| Installation identity generated on that machine | `[PASS/FAIL/BLOCKED/N/A]` | `[fill in]` |
| New identity ciphertext is DPAPI CurrentUser (no plaintext PEM, matching public key) | `[PASS/FAIL/BLOCKED/N/A]` | `[synthetic CI evidence + local host result; no key bytes]` |
| Offline DPAPI + ACL local readiness preflight (sanitized results only) | `[PASS/FAIL/BLOCKED/N/A]` | `[exact command/checkpoint, Windows profile reference, sanitized status; never upload key bytes]` |
| Effective Windows NTFS ACL/user-profile and backup handling verified on customer machine | `[PASS/FAIL/BLOCKED/N/A]` | `[sanitized ACL/recovery evidence; NEVER presume from CI]` |
| Legacy PEM migration, where applicable, separately authorized and verified | `[PASS/FAIL/BLOCKED/N/A]` | `[operator approval, migration evidence or N/A; no automatic conversion]` |
| Installation ID/public key registered by administrator | `[PASS/FAIL/BLOCKED/N/A]` | `[fill in]` |
| Grant matches customer, installation, product mode, MT5 login and broker server | `[PASS/FAIL/BLOCKED/N/A]` | `[fill in; do not include secrets]` |
| HTTPS gateway is reachable; no public Master API or MT5 bridge exposure | `[PASS/FAIL/BLOCKED/N/A]` | `[fill in]` |
| Bearer token supplied through process environment only; token not recorded | `[PASS/FAIL/BLOCKED/N/A]` | `[fill in]` |
| Activation accepted for the intended installation | `[PASS/FAIL/BLOCKED/N/A]` | `[timestamp / sanitized result]` |
| Denial paths covered by automated evidence (wrong binding, replay, revoked grant) | `[PASS/FAIL/BLOCKED/N/A]` | `[CI run/test reference]` |
| No credentials/private keys included in logs, tickets or handoff record | `[PASS/FAIL/BLOCKED/N/A]` | `[fill in]` |

Activation returning `ok: true` proves only that the gateway accepted the activation request. It does not prove MT5 connectivity, runtime health, executable orders, or LIVE authorization.

## 4. Trading-mode and execution boundary

| Check | Status | Evidence reference / sanitized note |
|---|---|---|
| SELF_MANAGED initial mode remains `PAUSE` | `[PASS/FAIL/BLOCKED/N/A]` | `[fill in]` |
| COPY_FOLLOWER uses only an explicitly authorized sizing mode | `[PASS/FAIL/BLOCKED/N/A]` | `[fill in]` |
| Follower execution acceptance is identified as simulated or approved DEMO only | `[PASS/FAIL/BLOCKED/N/A]` | `[fill in]` |
| No live order was sent as part of this handoff | `[PASS/FAIL/BLOCKED/N/A]` | `[fill in]` |
| Any future real MT5 execution has separate documented approval and its own acceptance evidence | `[PASS/FAIL/BLOCKED/N/A]` | `[approval reference or N/A reason]` |

**This record does not authorize LIVE trading.** Do not change Master `BOT_MODE`, ARM/AUTO, activate a real bridge, or send a LIVE test order as part of this package handoff.

## 5. Outcome and sign-off

- Overall outcome: `[PASS / FAIL / BLOCKED]`
- Open blockers / remediation owner / due date: `[fill in]`
- Sanitized evidence references: `[fill in]`
- Operator name or approved identity and sign-off: `[fill in]`
- Customer representative and sign-off: `[fill in]`
- Administrator/provisioning sign-off: `[fill in]`

Mark the operational handoff complete only when all required checks pass, all blockers are resolved, and customer/operator sign-off is recorded. Software CI passing is not a substitute for acceptance on the customer's actual machine.
