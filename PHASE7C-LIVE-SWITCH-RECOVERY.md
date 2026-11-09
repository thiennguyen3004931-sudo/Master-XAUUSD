# Phase7C LIVE Switch Preflight / Recovery

This hardens the transition from selected `DEMO` runtime to selected `LIVE` runtime after explicit LIVE capability has already been enabled.

## Failure that motivated this guard

A real local switch attempt reached the LIVE bridge successfully, but the LIVE MT5 terminal reported `terminalTradeAllowed=false`. The executor task is intentionally launched with `armed=true`, so Trend and Sideway preflight rejected startup with `MT5 automated trading is not enabled in terminal/account.`

The original switcher then attempted rollback. Its rollback path restored DEMO state files and restarted the bridge task, but a previously launched LIVE bridge listener still owned localhost port 8765. The DEMO bridge runner repeatedly failed with Windows socket error 10048 while the actual listener remained the LIVE bridge. This produced an inconsistent state: durable account selection said DEMO while the active bridge was still connected to LIVE.

LIVE remained session-DISARMED throughout this incident; no LIVE arm file was present.

## New switch preflight

Before any runtime mutation, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\preflight-phase7c-live-switch-local.ps1 `
  -WorkDir .runtime
```

The preflight requires:

- Administrator PowerShell;
- selected runtime `DEMO`;
- bot mode `PAUSE`;
- LIVE capability flags already enabled;
- exact LIVE risk/profile binding;
- exact configured LIVE terminal/login/server;
- REAL account mode;
- terminal Algo Trading permission enabled;
- account trading and Expert permissions enabled;
- zero LIVE XAUUSD positions and pending orders;
- no LIVE session arm file.

The terminal check is direct and read-only through the local MetaTrader5 Python package. It sends no order and does not touch Scheduled Tasks.

A disabled terminal Algo Trading button now blocks the switch **before** executor/bridge mutation.

## Deterministic DEMO recovery

After a failed switch, use:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\recover-phase7c-demo-after-failed-switch-local.ps1 `
  -WorkDir .runtime
```

Recovery:

1. forces bot `PAUSE`;
2. clears any LIVE arm state;
3. stops executor, account-bridge and verified legacy bridge tasks;
4. waits for singleton runner locks to release;
5. runs the canonical executor process-tree cleanup;
6. proves ownership of the single listener on the configured bridge port before terminating it;
7. restores canonical DEMO account/risk/task configuration;
8. starts and verifies the DEMO bridge;
9. requires zero DEMO XAUUSD positions and pending orders before executor restart;
10. restarts and strictly verifies the DEMO executor runtime;
11. finishes `DEMO + PAUSE + LIVE DISARMED`.

The recovery intentionally preserves the operator-approved LIVE environment capability flags. It does not arm LIVE and it does not send broker mutations.

## Guarded LIVE switch

Future LIVE switches should use the wrapper instead of invoking the legacy switcher directly:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\switch-phase7c-live-guarded-local.ps1 `
  -WorkDir .runtime `
  -ConfirmLiveExecution
```

The wrapper:

- runs the new terminal preflight first;
- invokes the existing canonical switcher only after the preflight passes;
- if the underlying switch throws, runs deterministic DEMO recovery;
- on success, requires selected runtime `LIVE`, bot `PAUSE`, and no LIVE arm file;
- stops at `EXPLICIT_LIVE_ARM_APPROVAL_REQUIRED`.

Account switch approval remains separate from LIVE ARM approval. Enabling terminal Algo Trading is a capability prerequisite only; the session-bound bridge arm remains the final independent REAL-mutation gate.
