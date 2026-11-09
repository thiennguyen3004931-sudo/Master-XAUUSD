# XAUUSD AI MASTER — Portable deployment

This guide packages the Git-tracked source code so the project can be moved to another computer without copying machine-local runtime state, credentials, or MetaTrader data folders.

## What the portable ZIP contains

The portable release is created from a clean Git commit with `git archive`. It contains source code, scripts, documentation, CI files, and committed example configuration only. The generated `PORTABLE-RELEASE-MANIFEST.json` records the source commit and safety boundary.

The package intentionally does **not** contain `.runtime`, local `.env` profiles, API keys, MT5 credentials, MetaTrader data directories, `node_modules`, compiled application output, logs, databases, LIVE arm state, or Windows Scheduled Tasks.

GitHub is the source-of-truth for code. Machine-local secrets and runtime state must remain separate and must never be committed to the repository.

## Build a portable ZIP

From a clean integration branch on Windows PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\package-phase7c-portable-release.ps1 `
  -RequiredCommit <MERGED_COMMIT_SHA>
```

The script writes a ZIP and SHA-256 checksum under `artifacts/`. That directory is gitignored. It refuses a dirty tracked working tree and checks the staging tree for local environment files, runtime directories, databases, logs, and generated dependency/build folders before producing the final archive.

The GitHub Actions workflow `Phase7C Portable Deploy Mobile Dev CI` also builds the same source-only package and uploads it as a workflow artifact. After a merge to the integration branch, the artifact corresponds to that merged Git commit.

## Prepare another Windows PC

Actual MT5 execution remains a Windows workload. Install two separate MetaTrader 5 terminals if you want the same DEMO/LIVE isolation used by the project: one terminal/session for DEMO and one for LIVE. Also install Git, Node.js 24+, pnpm 10.18+, and Python 3.12+.

Unzip the portable package (or clone the repository), open PowerShell in the project folder, then run a prerequisite-only check:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\bootstrap-phase7c-new-pc.ps1
```

This default mode is prepare/check only. It does not switch accounts, ARM LIVE, start trading, or send an order.

Create machine-local configuration templates:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\bootstrap-phase7c-new-pc.ps1 `
  -CreateLocalConfigTemplates
```

Then edit these **local gitignored files** for the new PC:

```text
packages/mt5-broker/bridge/.env.phase7b-demo
packages/mt5-broker/bridge/.env.phase7b-live
```

Fill only the values for that machine/account: terminal path, account login/server, local bridge API key and the existing account-specific settings. Do not copy a LIVE password or API key into GitHub.

Install dependencies and build explicitly:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\bootstrap-phase7c-new-pc.ps1 `
  -InstallDependencies `
  -Build
```

After both MT5 profiles are configured, optional setup actions remain explicit:

```powershell
# Run as Administrator only when registering the no-trigger guarded switch task.
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\bootstrap-phase7c-new-pc.ps1 `
  -RegisterAccountSwitchTask

# Install the read-only decision panel into configured DEMO and LIVE terminals.
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\bootstrap-phase7c-new-pc.ps1 `
  -InstallMt5Panels
```

The account-switch task is registered with no automatic trigger. The MT5 panel remains read-only and has `ORDER PERMISSION = NONE`.

## First activation on a new machine

Start with DEMO. Verify the local bridge identity, account allowlist, Telegram/runtime health, zero unexpected XAUUSD positions/orders, and executor ownership before enabling a strategy mode. Use the repository's existing strict account verifier and DEMO E2E flow before considering LIVE.

Moving from DEMO to LIVE is still a separate guarded account switch. The switch must finish `LIVE + PAUSE + DISARMED`. LIVE ARM is a separate explicit operation and must never be inferred from installation, bootstrap, package restore, or account selection.

## What cannot be made portable

The following remain machine-specific by design: MetaTrader installation/data paths, broker login/session, Windows Scheduled Task registration, local firewall/WebRequest configuration, local API keys, runtime PID/lock/state files, and LIVE arm state. Recreate or re-verify these on the destination PC rather than copying them from another machine.

## Backup recommendation

Use GitHub for all code and documentation. If you need disaster recovery for machine-local settings, keep an encrypted offline backup of the two local MT5 profile files and a written inventory of terminal paths/account identities. Never put those backups into this repository or the portable source ZIP.
