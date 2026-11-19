# Phase7C LIVE Capability Gate

This step sits after `preflight-phase7c-live-activation-local.ps1` and before any LIVE account switch or LIVE arm.

The helper is intentionally explicit:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\enable-phase7c-live-capability-local.ps1 `
  -WorkDir .runtime `
  -ConfirmEnableLiveCapability
```

It refuses to run without the explicit `-ConfirmEnableLiveCapability` switch.

Before changing the local LIVE env, the helper requires:

- PowerShell Administrator;
- selected runtime still `DEMO`;
- bot mode still `PAUSE`;
- healthy current DEMO bridge;
- the canonical LIVE activation preflight to pass immediately before the write;
- exact LIVE risk/profile binding to remain valid;
- `MT5_TRADING_ENABLED=false` and `XAUUSD_PHASE7C_ALLOW_LIVE_TRADING=false` immediately before the write.

The capability change updates the two local LIVE prerequisites atomically:

```text
MT5_TRADING_ENABLED=true
XAUUSD_PHASE7C_ALLOW_LIVE_TRADING=1
```

This is **not** a LIVE arm and does not authorize an order by itself. The helper does not invoke the account switcher, does not invoke `arm-phase7c-live-local.ps1`, does not start or stop project Scheduled Tasks, and does not send broker mutations.

LIVE arm state is cleared immediately before and after the capability write. The selected runtime must remain `DEMO`, the bot must remain `PAUSE`, and the original DEMO bridge session/login must remain unchanged.

A successful run ends with:

```text
PHASE7C_LIVE_CAPABILITY_STATUS=ENABLED_DISARMED
PHASE7C_LIVE_CAPABILITY_NEXT=EXPLICIT_LIVE_ACCOUNT_SWITCH_APPROVAL_REQUIRED
```

The next operation is a separate operator decision. Account switching to LIVE and session-bound LIVE arming remain distinct explicit steps.
