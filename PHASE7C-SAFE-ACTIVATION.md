# Phase7C Safe Activation

Use `scripts/activate-phase7c-safe-local.ps1` for local DEMO recovery when core ports may be occupied by stale project processes and CIM `Win32_Process.CommandLine` is unavailable or blank.

## Canonical DEMO command

```powershell
Set-Location "F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master"
$RuntimeWorkDir = Join-Path (Resolve-Path .).Path ".runtime"

.\scripts\activate-phase7c-safe-local.ps1 `
  -WorkDir $RuntimeWorkDir `
  -ArmExecutors `
  -TrendFixedVolume 0.12 `
  -SidewayRiskPercent 1 `
  -SidewayMaxLot 0.30
```

The safe wrapper freezes entry to `PAUSE`, stops a verified task-managed executor runner when necessary, stops Phase7C executors, performs conservative endpoint ownership checks for the API/Web/MT5-bridge listeners, delegates to the existing activation script, and restores Scheduled Task ownership when the executor task was already managing the runtime before recovery.

The wrapper deliberately finishes in `PAUSE`. Restore `AUTO`, `TREND`, or `SIDEWAY` only after strict verify and smoke are green.

## Endpoint ownership fallback

The fallback is read-only and fail-closed:

- API ownership requires both the Phase7C bot-mode payload and the Phase7C lot-settings payload to match the expected schema and safety ranges.
- Web ownership requires the running Vite server to expose the project-specific router source containing the Phase7C Control Center and Phase7B route markers.
- MT5 bridge ownership requires the authenticated `/health` response to match the bridge schema and report `accountMode=demo`.
- Endpoint proof authorizes termination of the **exact listener PID only**. It never authorizes a parent process or broader process tree.
- If ownership cannot be proven, the listener is kept and recovery fails with `Keep PAUSE` instead of killing an unknown process.

## Verification

```powershell
.\scripts\verify-phase7c-executors-local.ps1 `
  -WorkDir $RuntimeWorkDir `
  -RequireMigratedTask `
  -RequireTelegram

.\scripts\smoke-phase7c-runtime-local.ps1 `
  -WorkDir $RuntimeWorkDir
```

Required safety markers include `PHASE7C_VERIFY_ACCOUNT_MODE=demo`, `PHASE7C_VERIFY_AUTO_LOT_SAFETY=PASS`, `PHASE7C_VERIFY_OWNERSHIP=PASS`, `PHASE7C_VERIFY_TELEGRAM_STATUS=PASS`, `PHASE7C_VERIFY_STATUS=PASS`, and `PHASE7C_SMOKE_MT5_PANEL=PASS|ORDER_PERMISSION=NONE`.
