# XAUUSD Customer Agent — Handoff and Operations

This package contains customer-side libraries and bootstrap scripts only. It is **not** a standalone copy of the Master trading bot.

It does **not** contain Master strategy, risk, execution, MT5 bridge, server persistence, or Master source code. A successful package build or activation is not proof that a real customer terminal is installed correctly or that LIVE trading is accepted.

## 1. Supported delivery modes

### SELF_MANAGED

The customer uses their own installation identity and an administrator-provisioned grant. The server authorizes only the bot modes allowed by that grant. For first installation and handoff verification, keep `requestedBotMode` at `PAUSE`. Do not request AUTO or enable live trading merely because activation returns `ok: true`.

### COPY_FOLLOWER

The customer is provisioned as a follower and requests only an approved sizing mode, such as `EQUITY_RATIO`. Signed copy commands are checked against trusted signing keys, customer/license/installation/account/symbol binding, sequence and replay protections.

**Execution status:** the repository's follower acceptance currently uses a simulated/injected executor. The package does not include an MT5 bridge, and CI does not send a real MT5 order. Real follower execution requires a separately approved bridge integration and explicit DEMO/LIVE acceptance. Do not treat COPY_FOLLOWER as production-live-ready based on simulated CI alone.

## 2. Requirements

- A controlled Windows customer machine.
- Node.js 24.x.
- HTTPS access to the Customer API Gateway.
- The customer's approved MT5 login and broker server.
- A valid customer bearer token and an administrator-provisioned license/grant.

Keep the Customer API Gateway on HTTPS. Never expose the Master Control API or MT5 bridge publicly to make customer onboarding easier.

## 3. Generate an installation identity

From the extracted release directory, run on the customer's machine:

```powershell
node .\bin\generate-installation-identity.mjs
```

The command prints `INSTALLATION_ID` and `INSTALLATION_PUBLIC_KEY`. Send those two values to the administrator through the agreed secure provisioning channel.

Run this command once for a fresh installation. If any identity file already exists, it exits with `INSTALLATION_IDENTITY_ALREADY_EXISTS` and preserves the existing files. Reuse the enrolled identity for activation; do not delete the files to force regeneration. If initialization was interrupted or an identity file is missing, preserve the remaining files and use the approved recovery process with the administrator. Moving to a new PC requires the revocation and fresh-installation process in section 8.

**DPAPI-only new identity (Windows):** the generator now stores `keys/installation-private.dpapi` encrypted using Windows DPAPI `CurrentUser`. The public key and installation ID are separate files. The key can be decrypted only in an appropriate Windows user profile on the originating machine. Non-Windows generation fails closed; it does not fall back to plaintext. The activation utility validates the decrypted private/public key pair before making any network request.

**Never send or copy** `keys/installation-private.dpapi` or any pre-existing `keys/installation-private.pem`. Neither belongs in GitHub, tickets, chats, support bundles or customer public archives. A legacy PEM is **not** silently migrated: a legacy PEM or mixed-state identity causes initialization/activation to refuse to proceed. Preserve all existing identity files; do not delete, regenerate or overwrite an enrolled identity. Migration requires a separate authorized tool and controlled procedure.

**Release blocker remains:** DPAPI library/CLI synthetic CI is not evidence of the effective NTFS ACL, Windows user/profile recovery, anti-tampering by administrators or safe migration of existing installations. These checks plus customer-machine pilot and a trusted signed release are mandatory before any commercial handoff. Never move the DPAPI ciphertext to a different machine as a migration shortcut.

### Legacy unencrypted PEM migration — controlled maintenance only

A **separately confirmed** helper is available at `bin/migrate-legacy-installation-identity.mjs` for a legacy installation with `keys/installation-private.pem`, `keys/installation-public.txt` and `keys/installation-id.txt` already present. It is **not invoked automatically** by the identity generator or activation. Never run it as part of general installation or on a real customer's machine without a distinct operator-approved maintenance change window and verified backup/recovery plan.

On an isolated Windows test installation **containing only synthetic keys**, the explicit migration command is:

```powershell
node .\bin\migrate-legacy-installation-identity.mjs --confirm-preserve-legacy-pem
```

It rejects missing confirmation, invalid or mismatched keys, a missing/partial identity and an existing `.dpapi` target. It uses exclusive file creation (`wx`), encrypts the same Ed25519 private key under the current Windows DPAPI profile and verifies that the newly written ciphertext decrypts to the enrolled public key. **The old PEM is intentionally left untouched, and activation remains BLOCKED while it exists.** The tool neither deletes the old PEM nor claims that ordinary deletion securely removes Windows backups/SSD history. Interrupted output must be handled manually; never overwrite, silently recover by re-enrollment, or delete an identity to make the command pass.

The operator must separately review NTFS ACL inheritance, current user/profile, backup retention, matching license/grant/installation identity, and the authorized **post-verification disposition of legacy plaintext**. No automated cleanup or migration of any real customer key is authorized by this code merge. The helper is **not** an acceptance certificate for commercial release, SELF_MANAGED activation or COPY_FOLLOWER.

### Offline customer-machine readiness preflight (read-only)

On a **separately controlled Windows customer pilot PC**, run the local command below from the extracted customer release directory as the Windows user/profile that is intended to own the installation:

```powershell
node .\bin\check-customer-installation-readiness.mjs
```

This command has **no CLI arguments and no network/MT5 activity**. It checks for legacy plaintext PEM or missing/invalid identity files, invokes the conservative read-only NTFS ACL preflight for the `keys` folder and encrypted key, then verifies that the Windows CurrentUser DPAPI ciphertext decrypts to the registered public key. It never prints key material, account SIDs or local paths, modifies file permissions or authorizes customer activation.

`CUSTOMER_INSTALLATION_OFFLINE_READINESS=PASS` means only the local checks completed under that Windows user at that moment. Separate host and account verification, recovery/backup evidence, grants, approved publisher signing, client consent, and DEMO acceptance are **NOT VERIFIED** by this command. A `BLOCKED` result must not be bypassed by disabling the audit, reusing a plaintext PEM or changing requested bot modes. Do not run the command against a real customer install before the operator approves that pilot's scope.

## 4. Administrator provisioning

The administrator creates a license and grant bound to all applicable fields:

- customer ID;
- MT5 login and broker server;
- installation ID and installation public key;
- product mode;
- allowed bot mode for SELF_MANAGED, or allowed sizing mode for COPY_FOLLOWER.

Before activation, independently confirm that the grant is for the intended customer, terminal, account, broker server, installation and product mode. A mismatch must be treated as a denial, not worked around by editing local state.

## 5. Configure the agent

Copy:

```text
config/customer-agent.example.json
```

to:

```text
config/customer-agent.json
```

Set the approved HTTPS gateway URL, product mode, grant ID, MT5 login, broker server, and the allowed requested mode/sizing mode. Keep customer-specific configuration and credentials local; do not commit them.

For the first SELF_MANAGED handoff, leave `requestedBotMode` as `PAUSE`. For COPY_FOLLOWER, use only the sizing mode explicitly authorized by the administrator.

**Mandatory offline gate before activation (proposed software hardening):** when `node .\\bin\\activate-customer-agent.mjs` runs, it must first check the same installation's conservative read-only NTFS ACL policy and current-user DPAPI/private-public-key binding *before constructing any Gateway transport*. Run from the root of the extracted installation; the three identity-file configuration values must resolve exactly to `keys/installation-id.txt`, `keys/installation-public.txt`, and `keys/installation-private.dpapi` under that root. A different/relocated path, legacy PEM, inherited/broad ACL, wrong Windows user profile or failed DPAPI check **blocks activation**. Do not disable the gate, reset identity files or weaken NTFS permissions to make it pass. The gate does not change ACLs or activate MT5; a software check at a point in time is not full effective-permissions or customer-host acceptance. Real customer pilot use still requires separate operator approval.


## 6. Supply the API token and activate

Set the bearer token in the current PowerShell process; do not write it into the JSON configuration:

```powershell
$env:XAUUSD_CUSTOMER_API_TOKEN = "<customer bearer token>"
node .\bin\activate-customer-agent.mjs
```

Expected activation success includes:

```text
"ok": true
```

This means the Customer API Gateway accepted the activation request. It does **not** prove that MT5 is connected, that the customer runtime is healthy, that an order can be executed, or that LIVE use is approved. If activation fails or a binding does not match, stop and investigate; do not bypass the gate.

## 7. Customer handoff acceptance checklist

Record the result for each customer without recording tokens, passwords, private keys, or other secrets.

Use [`acceptance-record.template.md`](./acceptance-record.template.md) to record package evidence, installation/binding checks, the execution safety boundary, blockers, and separate operator/customer sign-off. Keep completed customer-specific records in the approved access-controlled record system; do not commit completed records or secrets to this repository.

- [ ] Package version, source commit and artifact/run ID recorded.
- [ ] Customer identity and product mode confirmed.
- [ ] Installation ID/public key registered; private key remains local.
- [ ] MT5 login and broker server match the administrator's grant.
- [ ] HTTPS gateway is reachable and the token is supplied only through the process environment.
- [ ] Activation succeeds for the intended installation.
- [ ] A wrong installation, mismatched account/broker, replayed proof or revoked grant is denied by the relevant automated/security checks.
- [ ] SELF_MANAGED remains at PAUSE during initial handoff; allowed modes are separately approved.
- [ ] COPY_FOLLOWER remains in simulated/DEMO acceptance until real broker binding and execution receive separate approval.
- [ ] Handoff record names the exact commit and evidence; it contains no credentials.
- [ ] Customer and operator sign-off is recorded separately from software CI.

Automated tests prove the tested software paths, not installation on a customer's actual PC. Mark the operational handoff complete only after the customer's environment checks and sign-off are recorded.

## 8. Revocation and moving to a new PC

Do not copy the old installation private key to the replacement PC.

1. Ask the administrator to revoke/retire the old installation grant using the approved administrative process.
2. Generate a fresh installation identity on the new PC.
3. Send the new installation ID and public key to the administrator.
4. Have the administrator bind a new grant to the intended customer, account, broker server, product mode and new installation.
5. Verify that the old installation is denied and the new installation is accepted; retain the migration audit evidence.
6. Keep the new installation at PAUSE / simulated or DEMO acceptance until its own checks pass.

Do not edit server databases, grant registries or local security state manually to force a migration.

## 9. Fail-closed troubleshooting

If activation or binding fails:

1. Check the configured HTTPS gateway URL and basic HTTPS reachability.
2. Confirm the bearer token is present in the current process environment and has not been pasted into the config file.
3. Compare the installation ID/public key, grant ID, product mode, MT5 login and broker server with the administrator's record.
4. Ask the administrator to verify grant status and audit events.
5. Preserve sanitized error codes and timestamps only. Never attach tokens, passwords, private keys, full environment dumps or broker secrets to logs/tickets.

Do not bypass an authentication, installation, account, sequence or replay check. Fail closed and escalate the mismatch.

## 10. Safety boundary and release status

- Master source: not distributed.
- Installation private key: generated and stored locally.
- Bearer token: process environment only.
- Network transport: HTTPS only.
- Replay protection and customer/installation binding: required.
- Customer agent itself: no direct MT5 order or position mutation.
- Included follower executor acceptance: simulated only.
- LIVE ARM, Master BOT_MODE changes, account switching, and LIVE test orders: not part of customer package acceptance.

The final production handoff requires a successful acceptance run on the exact final `main` commit, a verified package artifact, a successful customer installation/binding check, and separate approval for any real MT5 execution. Never infer current production BOT_MODE or ARM status from an old monitor snapshot when the bridge cannot be read.

**Release status:** a passing ZIP/package checksum check is not a signed commercial release. Verify both the GitHub Actions outer artifact digest and inner customer ZIP digest; require trusted publisher signature before customer distribution. Keep a known-good rollback artifact and record the exact final-main CI evidence. No routine in this package authorizes MT5 DEMO or LIVE execution.
