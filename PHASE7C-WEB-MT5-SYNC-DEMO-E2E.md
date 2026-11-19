# Phase7C Web + MT5 Sync and DEMO End-to-End

## Scope

This change keeps the Web dashboard and the MT5 decision panel on the same Semantic UI v2 contract while preserving the existing trading strategy and safety boundaries.

It does **not** change Trend/Sideway entry logic, SL/TP/BE/partial rules, lot/risk settings, account selection, LIVE capability, LIVE ARM state, or executor ownership.

## Shared UI contract

Both Web and MT5 read the Phase7C Semantic UI v2 contract and expose the same operational groups:

- selected account mode: DEMO / LIVE
- active bot mode and effective strategy
- market regime and confidence
- Entry / Stop Loss / TP or +10 management milestone
- floating P/L for a managed position
- AUTO / regime selection reason
- Trend wait reason
- Sideway wait reason
- entry reason
- hold reason
- stop-loss move reason
- +10 one-third partial reason
- full-exit reason

The MT5 panel remains read-only and contains no trading mutation API. `ORDER PERMISSION = NONE` is a required build/install marker.

The MT5 panel also compares the selected runtime account mode from Semantic UI with the account mode of the terminal on which the panel is attached. A panel attached to the non-selected terminal renders a runtime/terminal mismatch warning instead of presenting stale data as current.

## Safe synchronized deploy

Use:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\deploy-phase7c-web-mt5-sync-local.ps1 `
  -WorkDir .runtime `
  -RequiredCommit <commit>
```

The wrapper:

1. captures selected account, bot mode and LIVE arm-file presence;
2. runs the existing safe Web/API deploy;
3. installs/compiles the read-only panel into both configured DEMO and LIVE MT5 data folders;
4. proves account, bot mode and LIVE arm-file presence did not change;
5. verifies the Semantic UI v2 reason fields and `mt5OrderPermission=NONE`;
6. runs strict selected-account verification with Telegram.

It does not perform account switch, ARM/DISARM, order submission, position modification, or strategy/risk mutation.

## Real-strategy DEMO E2E

Use only after the synchronized deploy is verified:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\run-phase7c-demo-e2e-local.ps1 `
  -WorkDir .runtime `
  -ConfirmDemoExecution `
  -MaxWaitMinutes 360
```

The runner uses the existing canonical Trend/Sideway executors. It does not manufacture a validation order or bypass entry rules.

If selected runtime is LIVE, it first sets PAUSE and uses the already-guarded Web account-switch API to move to DEMO. The switch must end in DEMO + PAUSE with no LIVE arm file.

It then verifies DEMO, records the existing MT5 performance trade IDs, sets AUTO, and observes Semantic UI until one new `SYSTEM`-owned Trend/Sideway trade has completed. It records whether SETUP_READY, MANAGING, +6/structural SL movement, and +10 partial were observed. A full closed trade is detected through the account-aware MT5 Performance reconstruction, so a partial close alone is not counted as completion.

The runner always attempts to return the bot to PAUSE. It never switches back to LIVE, never ARM's LIVE, and never sends a manual test order.

No complete trade within the requested window is a timeout, not evidence that strategy logic failed. Do not force an entry to make the E2E pass.

## LIVE boundary after DEMO E2E

Returning to LIVE is a separate guarded account switch. The expected post-switch state is LIVE + PAUSE + DISARMED. Any later LIVE ARM and AUTO transition remain separate explicit actions.
