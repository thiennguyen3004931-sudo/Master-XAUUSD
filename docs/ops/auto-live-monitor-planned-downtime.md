# AUTO LIVE monitor — planned downtime runbook

This runbook changes only **operator monitoring metadata**. It never stops or starts the bot, changes BOT_MODE, switches accounts, ARMs LIVE, or sends/updates MT5 orders. **Do not run either command merely to silence a genuine unexplained outage.**

## Preconditions

1. The operator independently confirms the trading bot is intentionally stopped or undergoing planned maintenance, using authorized local operating procedures.
2. Any existing positions and their protective management are independently accounted for. An offline lease is **not** proof of flat exposure, a healthy bridge, a disarmed session, or an acceptable risk position.
3. The production root belongs to the intended Windows host. Do not copy maintenance markers to other hosts.

## Declare planned downtime

Run explicitly on the production host; the declaration expires in 1–24 hours:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\ops\set-auto-live-monitor-offline-lease.ps1 -Enable -Reason PLANNED_SHUTDOWN -DurationHours 12 -ConfirmPlannedDowntime
```

This writes only `.runtime/ops/auto-live-monitor-offline-lease.json` on the selected host. The operator must renew it explicitly for longer planned downtime. Keep this local runtime file out of Git, artifacts, logs and customer bundles.

When a fresh bridge GET fails specifically from **connectivity failure**, an unexpired well-formed lease produces:

```text
MONITOR_BRIDGE_READ_STATUS=OFFLINE_EXPECTED
MONITOR_RUNTIME_HEALTH=NOT_VERIFIED
MONITOR_DATA_FRESHNESS=UNAVAILABLE
MONITOR_BOT_MODE=UNKNOWN
MONITOR_ARM_STATUS=UNKNOWN
MONITOR_POSITION_COUNT=UNKNOWN
MONITOR_PRODUCTION_MUTATION=NONE
```

A scheduled monitoring run may complete successfully with the explicit *expected offline* classification; this is **not** a green trading-runtime health check. An issue event and metadata can record the transition when `Notify=true`, without changing the prior full trading snapshot. The prior snapshot is historical.

## Clear and verify after maintenance

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\ops\set-auto-live-monitor-offline-lease.ps1 -Clear
```

Then run the canonical read-only preflight and monitor, check fresh bridge and source attestations, and separately obtain any required approvals before modifying bot mode or ARM. Never assume automatic trading reactivation.

## Safety and failure semantics

- Absent, unreadable, malformed, expired, future-dated or over-24-hour leases **do not suppress** connectivity incidents.
- Authentication errors, invalid responses, and other read failures **remain failures** even if the lease is valid.
- If the bridge is reachable, the monitor uses the fresh full observation and ignores the lease.
- The monitor never assigns PAUSE, DISARMED, zero positions, or a healthy status on bridge read failure.
- This workflow does not authorize production runtime control or LIVE trade execution.
