# Phase7C new-machine bootstrap

This procedure installs a clean LIVE runtime on a replacement Windows machine from the private GitHub repository. It intentionally does **not** copy the old `.runtime` directory and always finishes in **PAUSE + DISARMED**.

## Safety boundary

Before running the bootstrap:

1. The old machine must be stopped.
2. XAUUSD must have zero open positions and zero pending orders.
3. MT5 must be installed on the new machine, logged into the intended LIVE account, and Algo Trading must be enabled.
4. Run PowerShell as Administrator.
5. Install Git, Node.js 24.x, pnpm 10.18.0, and Python 3.
6. Git authentication for the private repository must already work on the new machine.

Never run the same LIVE account ARMED on both machines.

The bootstrap does not call `ARM_LIVE`, does not set AUTO, and does not place a test order.

## What comes from GitHub

The production working copy is cloned directly from:

`https://github.com/thiennguyen3004931-sudo/xauusd-ai-master-core.git`

and pinned to the approved production commit:

`800ab441ffa1eec45488f7b7ff92c15b3a44846e`

The local production checkout remains on branch `main` at that exact commit so the existing canonical deploy/attestation scripts can verify it.

## What must stay outside GitHub

Three machine/account-specific inputs are required:

- LIVE bridge env file
- Telegram env file containing `ZIQ_TELEGRAM_BOT_TOKEN` and `ZIQ_TELEGRAM_CHAT_ID`
- risk profile JSON

Optionally, a persisted strategy-entry-condition JSON can be supplied. If it is omitted, the runtime uses the canonical safe default entry-condition state.

These files must be transferred securely from the old machine or recreated on the new machine. Do not commit them to GitHub.

Typical old-machine sources are:

- `packages\mt5-broker\bridge\.env.phase7b-live`
  - On the new machine, update `MT5_TERMINAL_PATH` in this copied file if MT5 is installed at a different path.
- `.env.phase7b-telegram`
- `.runtime\phase7c-lot-settings.json`
- optional: `.runtime\phase7c-strategy-entry-conditions.json`

## Bootstrap repo versus production repo

Clone the current private repository once as a small bootstrap working copy, for example:

```powershell
cd C:\
git clone https://github.com/thiennguyen3004931-sudo/xauusd-ai-master-core.git XAUUSD_BOOTSTRAP
cd C:\XAUUSD_BOOTSTRAP
```

The installer then creates a **separate clean production working copy**, for example:

`F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master`

Do not pass the bootstrap directory itself as `-ProjectRoot`.

## Run

Example:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-phase7c-new-machine-local.ps1 `
  -ProjectRoot "F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master" `
  -LiveEnvFile "C:\XAUUSD_MIGRATION\.env.phase7b-live" `
  -TelegramEnvFile "C:\XAUUSD_MIGRATION\.env.phase7b-telegram" `
  -RiskProfileFile "C:\XAUUSD_MIGRATION\phase7c-lot-settings.json" `
  -StrategyEntryConditionsFile "C:\XAUUSD_MIGRATION\phase7c-strategy-entry-conditions.json" `
  -ConfirmOldMachineStopped
```

If no persisted strategy-entry-condition file is required, omit that parameter.

Use `-SkipPanelInstall` if the MT5 decision panel should be installed later.

## What the installer does

The installer:

1. verifies Administrator context and required tools;
2. clones a separate production working copy from GitHub;
3. verifies the expected commit belongs to `origin/main`;
4. checks out local `main` at the exact approved production commit;
5. verifies local secrets/runtime paths are git-ignored;
6. copies only the supplied LIVE/Telegram config files;
7. rebuilds the LIVE-bound risk profile for the new MT5 terminal path/account identity;
8. creates fresh account state and forces bot mode to `PAUSE`;
9. removes any LIVE arm file, therefore starting `DISARMED`;
10. creates fresh LIVE authorization for the new machine profile;
11. installs locked Node and Python dependencies;
12. registers the canonical account bridge, Web/API, and SYSTEM executor tasks;
13. proves the MT5 bridge is LIVE, healthy, the expected account/server, and flat;
14. starts the lifecycle while still PAUSE + DISARMED;
15. runs the existing canonical runtime-ready recovery/deploy acceptance;
16. verifies exact runtime-source attestation and a flat broker;
17. optionally installs the read-only MT5 decision panel.

## Required final markers

A successful migration ends with:

```text
PHASE7C_NEW_MACHINE_STATUS=PASS
PHASE7C_NEW_MACHINE_SOURCE_COMMIT=800ab441ffa1eec45488f7b7ff92c15b3a44846e
PHASE7C_NEW_MACHINE_SOURCE_ATTESTATION=EXACT_MATCH
PHASE7C_NEW_MACHINE_ACCOUNT_MODE=LIVE
PHASE7C_NEW_MACHINE_BOT_MODE=PAUSE
PHASE7C_NEW_MACHINE_ARM=DISARMED
PHASE7C_NEW_MACHINE_POSITIONS=0
PHASE7C_NEW_MACHINE_PENDING_ORDERS=0
PHASE7C_NEW_MACHINE_LIVE_TEST_ORDER=NONE
PHASE7C_NEW_MACHINE_NEXT_ACTION=VERIFY_THEN_MANUAL_AUTO_AND_ARM
```

Only after those markers are verified should the operator use the Web Control Center to select AUTO and then explicitly ARM LIVE.
