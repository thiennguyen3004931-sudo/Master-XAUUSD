# Phase7C SYSTEM Lifecycle Broker Design

Date: 2026-08-27  
Status: Proposed for implementation after user review  
Base commit: `37e71c750ca1b4d21073f4cbf03c2b5f6df37682`

## 1. Problem statement

Phase7C currently has a privilege split that prevents Web lifecycle operations from safely restarting the executor runtime when lot settings change.

Observed runtime:
- API/Web control runs as the interactive Windows user and is not elevated.
- `XAUUSD-Phase7C-Executors` runs as `SYSTEM`, `Highest`, `ServiceAccount`.
- Supervisor, Trend, Sideway, Telegram mode controller, regime notifier, and trade notifier are descendants of the SYSTEM task.
- Lifecycle reports the executor tree as running, but `ready=false` when `lotSettings.restartRequired=true`.

Current `phase7c-lifecycle.service.ts` calls `schtasks.exe /End` and then `stop-phase7c-executors-local.ps1` from the non-elevated API token. The `/End` error is swallowed. The stopper then attempts to control SYSTEM-owned processes and can fail. This leaves the bot in `PAUSE` with `runtimeReady` blocked even though the executor tree itself is healthy.

The current SYSTEM task runner also resolves effective lot settings before entering its permanent retry loop. Restarting only the supervisor process therefore does not guarantee that newly saved lot settings are re-read.

## 2. Approved architecture

The Scheduled Task remains the single privileged execution boundary.

**The SYSTEM lifecycle runner always stays alive. Web/API never directly stops the Scheduled Task and never directly kills or launches privileged executor processes. Web/API only submits one of three bounded lifecycle requests: `START`, `STOP`, or `RESTART`.**

The SYSTEM runner owns all mutations to the privileged executor tree.

```text
Web / API (non-elevated)
        |
        | atomic bounded request
        v
.runtime/phase7c-lifecycle-broker/inbox/request.json
        |
        v
XAUUSD-Phase7C-Executors
SYSTEM + Highest
Lifecycle Broker Runner
        |
        +-- validates request and safety gates
        +-- reads canonical account/task/lot configuration
        +-- START / STOP / RESTART supervisor tree
        +-- writes status/results/heartbeat
        |
        v
Supervisor (SYSTEM)
   +-- Trend
   +-- Sideway
   +-- Telegram mode
   +-- Regime notifier
   +-- Trade notifier
```

The API remains non-elevated. No task ACL is broadened to grant the Web user direct `/Run`, `/End`, `taskkill`, or arbitrary SYSTEM process control.

## 3. Goals

1. Allow Web Control Center to start, stop, and restart Phase7C executors without Administrator prompts after one-time Scheduled Task installation/migration.
2. Keep the privileged lifecycle broker alive while trading executors are stopped.
3. Preserve the rule that every lifecycle transition is fail-safe in `PAUSE`; AUTO remains a separate explicit Web action.
4. Preserve zero-position protection for STOP and RESTART.
5. Re-read canonical lot settings before every START or RESTART so `lotSettings.restartRequired` clears only after the newly launched runtime actually uses the new profile.
6. Preserve DEMO/LIVE account isolation and existing LIVE authorization/ARM boundaries.
7. Make lifecycle failures auditable instead of swallowing task-control errors.
8. Avoid arbitrary command execution through the privileged request channel.

## 4. Non-goals

- No change to Trend or Sideway strategy logic.
- No change to entry, SL, TP, BE, partial-close, HOLD, recovery, or exit contracts.
- No change to Telegram trade formatting.
- No automatic AUTO activation.
- No automatic LIVE ARM.
- No direct MT5 order test for lifecycle validation.
- No elevation of the API process.
- No user-granted direct control permission on the SYSTEM Scheduled Task.
- No generic shell, script path, command line, PID, lot value, account secret, or arbitrary argument support in lifecycle requests.

## 5. Broker runtime layout and ACL boundary

Use a dedicated broker directory with separate writable inbox and SYSTEM-owned state:

```text
.runtime/phase7c-lifecycle-broker/
  inbox/
    request.json
  state/
    status.json
    heartbeat.json
  results/
    <requestId>.json
  logs/
    broker.log
```

The one-time elevated installer must apply explicit ACLs instead of relying on broad inherited `.runtime` permissions:

- `SYSTEM`: Full Control on the broker tree.
- `Administrators`: Full Control on the broker tree.
- configured Web/API Windows user SID: Modify on `inbox/` only; Read on `state/`, `results/`, and `logs/`.
- generic `Users` / `Authenticated Users`: no additional write permission beyond what is explicitly required.

The installer records the configured Web/API user SID used for the inbox ACL. If the API later runs under a different Windows identity, lifecycle capability must fail closed until the task/broker ACL is re-registered.

All JSON writes use temp-file + atomic rename/replace semantics.

The request channel is local-file-only and is not a general IPC command channel.

## 6. Request contract

Version 1 request:

```json
{
  "version": 1,
  "requestId": "uuid",
  "action": "START | STOP | RESTART",
  "requestedAt": 1787830000000,
  "source": "WEB_CONTROL_CENTER",
  "reason": "USER_START | USER_STOP | LOT_SETTINGS_CHANGED | RECOVERY_START"
}
```

Rules:
- `version` must equal `1`.
- `requestId` must be a valid UUID and is the idempotency key.
- `action` is a closed enum: `START`, `STOP`, `RESTART` only.
- `source` is a closed enum; initially only `WEB_CONTROL_CENTER`.
- `reason` is a closed enum used for audit only.
- Unknown properties are rejected.
- A request older than 120 seconds is rejected.
- Only one request may be in flight. A new request while another is active is rejected with `REJECT_BROKER_BUSY`; the API must not overwrite an active inbox request.
- Request must not contain executable path, script path, account path, environment path, PowerShell, command line, PID, lot value, login, server, ARM data, token, or arbitrary arguments.

The SYSTEM runner resolves account mode, env file, lot profile, node path, pnpm path, runtime directory, and LIVE authorization state from canonical project state/configuration, never from `request.json`.

## 7. Idempotency and results

Each handled request gets a dedicated immutable result file:

```text
results/<requestId>.json
```

Example:

```json
{
  "version": 1,
  "requestId": "uuid",
  "action": "RESTART",
  "status": "SUCCEEDED | REJECTED | FAILED | NOOP",
  "reasonCode": "OK_RESTARTED",
  "message": "...",
  "startedAt": 1787830000100,
  "completedAt": 1787830004200,
  "supervisorPid": 12345,
  "accountMode": "DEMO",
  "appliedLotProfile": {
    "trendFixedLot": 0.12,
    "sidewayRiskPercent": 1,
    "sidewayMaxLot": 0.12
  }
}
```

The existence of `results/<requestId>.json` makes replay idempotent: the same request ID is never executed twice. Keep a bounded result history, for example the most recent 128 results, and remove older results only after they are outside the freshness/reconciliation window.

Initial canonical reason codes:
- `OK_STARTED`
- `OK_STOPPED`
- `OK_RESTARTED`
- `NOOP_ALREADY_RUNNING`
- `NOOP_ALREADY_STOPPED`
- `REJECT_BROKER_BUSY`
- `REJECT_BOT_NOT_PAUSED`
- `REJECT_OPEN_XAUUSD_POSITION`
- `REJECT_ACCOUNT_INVALID`
- `REJECT_BRIDGE_UNAVAILABLE`
- `REJECT_LIVE_AUTH_INVALID`
- `REJECT_REQUEST_INVALID`
- `REJECT_REQUEST_STALE`
- `REJECT_REQUEST_DUPLICATE`
- `FAIL_STOP_TIMEOUT`
- `FAIL_START_TIMEOUT`
- `FAIL_SUPERVISOR_EXITED`
- `FAIL_INTERNAL`

## 8. Broker state machine

Canonical states:

```text
BOOTING
  -> IDLE
  -> STARTING
  -> RUNNING
  -> STOPPING
  -> IDLE
  -> RESTARTING
  -> RUNNING
  -> BLOCKED
  -> ERROR_RETRYING
```

`state/status.json` exposes at least:
- broker state
- broker PID
- supervisor PID
- desired executor state: `RUNNING | STOPPED`
- current account mode
- in-flight request ID/action or null
- last handled request ID/action/result
- last error/reason code
- updated timestamp
- applied lot profile or deterministic hash/version

`state/heartbeat.json` is refreshed at least every 2 seconds while the broker process is alive, including `IDLE`. This distinguishes `Broker alive / executors IDLE` from `SYSTEM task dead`.

## 9. Boot policy

The new broker intentionally separates **SYSTEM service availability** from **trading executor startup**.

At Windows boot:
1. `XAUUSD-Phase7C-Executors` starts the SYSTEM broker.
2. Broker enforces/validates bot mode `PAUSE`.
3. Broker enters `IDLE` with desired executor state `STOPPED`.
4. Broker does **not** automatically launch Trend/Sideway/Telegram executors.
5. User starts the executor runtime from Web with `BẬT BOT` / START.
6. AUTO is never enabled automatically.

This is safer than the old task behavior and matches the approved model that Web sends START/STOP/RESTART while the privileged runner always remains alive.

A broker crash/restart within the same Windows session also returns fail-safe to `IDLE / PAUSE`; it does not infer that AUTO or executor RUNNING should be restored automatically.

## 10. Safety validation boundary

The API performs existing Web preflight before it writes a request. The SYSTEM broker performs its own no-bypass validation before privileged mutation and never trusts request-supplied runtime facts.

The broker may use the configured localhost `ControlApiUrl` and existing canonical read-only bridge/lifecycle probes to obtain account/MT5 state. If those probes are unavailable or ambiguous, the action is rejected; the broker does not guess.

### START gates
- request valid, fresh, and not busy
- canonical account-mode state valid
- bot mode is `PAUSE`
- MT5 bridge reachable
- broker account mode matches configured account mode
- bridge trading enabled
- terminal trading allowed
- expert/algo trading allowed
- XAUUSD open positions = 0
- Telegram configuration exists
- canonical executor task configuration valid and armed

### STOP gates
- bot mode is `PAUSE`
- MT5/position probe reachable
- XAUUSD open positions = 0

If position state cannot be verified, STOP is rejected. Emergency manual Administrator recovery remains outside the Web request path.

### RESTART gates
RESTART requires both STOP and START gates. It is used when lot settings or another bounded runtime change requires a fresh executor launch.

## 11. LIVE authorization and ARM semantics

Lifecycle and AUTO authorization remain separate.

For LIVE START or RESTART:
- require canonical LIVE account configuration and the existing durable/preauthorized LIVE execution boundary required to launch the LIVE executor runtime;
- do not create, repair, or extend LIVE authorization;
- do **not** require a session LIVE ARM merely to start/restart executors in PAUSE.

LIVE ARM remains a separate session-bound gate for enabling AUTO. Therefore the intended LIVE flow remains:

```text
LIVE selected
  -> START executors
  -> RUNNING / PAUSE
  -> ARM LIVE
  -> ARMED
  -> user explicitly enables AUTO
```

If a bridge session change invalidates an existing ARM during/after lifecycle work, the executor runtime may still be RUNNING in PAUSE, but AUTO remains blocked until the user re-ARM LIVE.

DEMO remains `ARM NOT_REQUIRED`.

## 12. Applying lot settings correctly

The SYSTEM broker must not cache effective lot values outside the per-launch path.

Before every START and RESTART launch it re-reads:
1. `.runtime/phase7c-executor-task-config.json`
2. current canonical account-mode state
3. `.runtime/phase7c-lot-settings.json` when present
4. canonical account env configuration

Then it validates the effective risk profile and passes those freshly resolved values to `run-phase7c-executors-local.ps1`.

After launch, existing lifecycle readiness continues to compare configured vs active lot profile. `restartRequired` becomes false only when active runtime status confirms the new profile.

## 13. START behavior

1. API sets/keeps bot mode `PAUSE`.
2. API performs existing account/bridge/position/Telegram preflight.
3. API verifies broker heartbeat/capability.
4. API atomically writes `START` and waits for the matching request result.
5. Broker validates privileged gates.
6. If executor runtime is already healthy and active lot/account profile matches canonical config, return `NOOP_ALREADY_RUNNING`.
7. Otherwise broker re-reads canonical launch config and starts the supervisor tree as SYSTEM.
8. Broker records supervisor PID/state.
9. API waits for existing lifecycle READY: supervisor + Trend + Sideway + Telegram + regime notifier + active lot profile + account guard.
10. Success state is `RUNNING / READY / PAUSE`.
11. AUTO still requires a separate user click and existing AUTO safety gates.

## 14. STOP behavior

1. API sets bot mode `PAUSE`.
2. API verifies zero XAUUSD positions.
3. API submits `STOP`.
4. Broker independently confirms PAUSE and zero XAUUSD positions.
5. Broker stops the supervisor/executor tree as SYSTEM using canonical stopper logic.
6. Broker remains alive.
7. Stable state:

```text
Scheduled Task: Running
Lifecycle Broker: IDLE
Executors: STOPPED
Bot mode: PAUSE
```

## 15. RESTART behavior

1. API sets bot mode `PAUSE`.
2. API verifies zero XAUUSD positions and existing lifecycle guards.
3. API submits `RESTART`.
4. Broker revalidates the same safety gates.
5. Broker stops the SYSTEM executor tree.
6. Broker re-reads canonical task/account/lot configuration.
7. Broker launches a fresh SYSTEM supervisor tree.
8. API waits for READY and confirms active lot equals configured lot.
9. Bot remains `PAUSE`.
10. User may then explicitly enable AUTO, subject to DEMO/LIVE AUTO gates.

This replaces the current API-side `/End` + local stopper path for normal Web lifecycle control.

## 16. Crash and recovery behavior

### Supervisor/executor crash
Any broker-detected unexpected supervisor exit is treated as a safety event:
- broker records `ERROR_RETRYING` or `BLOCKED`;
- bot mode is forced/confirmed `PAUSE` through the canonical mode path;
- broker does **not** automatically restore AUTO;
- broker may restart the executor tree only after the same START safety gates pass;
- post-recovery state is `RUNNING / PAUSE`, requiring an explicit user AUTO action.

### Executor desired state STOPPED
Do not restart executors. Remain `IDLE`.

### Broker process/task crash
Task Scheduler restarts the broker according to the installed task/recovery policy. On broker startup, fail-safe boot policy applies: `PAUSE`, executors `STOPPED`, broker `IDLE`.

### API crash after request submission
Broker completes or rejects the persisted request. After API recovery it reconciles by `requestId` from `results/` instead of reissuing the mutation.

### Duplicate request
Same `requestId` returns the existing result and never executes twice.

### Malformed/stale request
Reject and preserve current executor state.

## 17. API/service changes

`apps/api/src/services/phase7c-lifecycle.service.ts` stops owning privileged process mutation.

Remove from the normal Web lifecycle path:
- `schtasks.exe /End`
- direct execution of `stop-phase7c-executors-local.ps1`
- user-token `launchSelectedSupervisor()`
- user-token `taskkill` of executor lifecycle processes

Introduce a focused file-protocol client, suggested:

```text
apps/api/src/services/phase7c-lifecycle-broker.service.ts
```

Responsibilities:
- verify broker heartbeat/capability
- serialize to one in-flight request
- atomically write the closed request schema
- poll matching immutable result/status
- map canonical broker reason codes to Web errors
- preserve existing preflight and final READY verification
- never execute elevated commands

## 18. SYSTEM runner changes

Evolve `scripts/run-phase7c-executor-task-runner-local.ps1` from an unconditional supervisor restart loop into the persistent lifecycle broker.

Responsibilities:
- retain startup runner single-instance lock
- enforce fail-safe PAUSE on broker start/recovery
- publish heartbeat/status
- parse/validate bounded request files
- enforce one in-flight mutation
- maintain desired executor state
- re-read canonical configuration on every launch
- launch supervisor as SYSTEM
- stop supervisor tree as SYSTEM
- persist immutable results
- remain alive in IDLE/BLOCKED states

If necessary, extract parsing/state helpers into a focused PowerShell library rather than growing one untestable runner file. Avoid unrelated refactoring.

## 19. Scheduled Task and installer changes

Keep one canonical task:

```text
XAUUSD-Phase7C-Executors
Run As: SYSTEM
RunLevel: Highest
Trigger: At system startup
Action: run-phase7c-executor-task-runner-local.ps1
```

Do not add a Web-user lifecycle task and do not grant the interactive user direct task-control rights.

The elevated installer/registration path must verify:
- SYSTEM principal
- Highest run level
- expected runner path
- startup trigger
- broker directory ACLs and configured API user SID
- broker heartbeat after registration/migration

## 20. UI behavior

No new large UI section is required. Control Center remains the single ARM/lifecycle surface.

Lifecycle display may distinguish:
- `BROKER READY · EXECUTORS IDLE`
- `STARTING`
- `RUNNING · PAUSE`
- `RESTARTING`
- `BLOCKED: <reason>`

When configured lot differs from active lot:
- display `Cần khởi động lại để áp dụng cấu hình lot`;
- `KHÔI PHỤC BOT` / start action resolves to broker `RESTART` when runtime is already running with stale lot settings;
- AUTO remains blocked until lifecycle `ready=true`.

## 21. Observability and audit

Do not swallow privileged lifecycle errors.

Record without secrets:
- request ID/action/source/reason
- API submission timestamp
- broker accepted/rejected timestamp
- canonical rejection/failure reason code
- state transition
- supervisor PID
- account mode
- effective lot profile applied at launch
- timeout/error

Never log Telegram tokens, chat IDs, bridge passwords, or account env secret values.

## 22. Timeout policy

Initial bounded timeouts:
- broker heartbeat stale threshold: 5 seconds
- request pickup: 5 seconds
- SYSTEM executor stop: hard upper bound 25 seconds
- supervisor launch acknowledgement: 10 seconds
- full lifecycle READY: retain current 50-second window initially

On timeout:
- bot remains `PAUSE`
- API reports canonical timeout reason
- broker remains alive when possible
- no AUTO mutation
- no ARM mutation

## 23. Testing strategy

Implementation uses TDD with intentional RED before production changes.

### RED contracts
Tests must require:
1. API lifecycle service no longer uses `schtasks /End` for Web lifecycle.
2. API no longer directly launches/stops privileged executor trees.
3. request schema accepts only START/STOP/RESTART and rejects unknown/arbitrary command fields.
4. inbox/state ACL contract does not make SYSTEM state writable by generic users.
5. one in-flight request only; busy request cannot be overwritten.
6. STOP with XAUUSD position > 0 is rejected.
7. STOP with unverifiable position state is rejected.
8. RESTART with bot not PAUSE is rejected.
9. DEMO START requires no ARM while preserving normal account/bridge guards.
10. LIVE START/RESTART requires durable LIVE authorization but does not require session ARM.
11. LIVE AUTO still requires current session ARM through the existing AUTO gate.
12. STOP leaves broker alive and reports IDLE.
13. START from IDLE launches executor runtime.
14. RESTART re-reads changed lot settings and launches with new values.
15. duplicate request ID executes at most once.
16. malformed/stale request is rejected without changing executor state.
17. broker or supervisor recovery forces PAUSE and never restores AUTO automatically.
18. broker boot starts IDLE with executors STOPPED.

### Windows compatibility
PowerShell source/contract tests run on both:
- PowerShell 7
- Windows PowerShell 5.1

Avoid source-test encoding patterns that fail Windows PowerShell 5.1.

### Build/regression
Require at least:
- API build
- Web build
- Phase7C Web lifecycle/source CI
- Sideway Regime regression suite
- existing unarmed/LIVE safety contracts
- notifier regression if shared startup source affects notifier lifecycle

No LIVE MT5 order is required for validation.

## 24. Deployment and one-time migration

1. Merge only after RED-to-GREEN evidence and required CI passes.
2. On Windows require a clean working tree before sync.
3. Verify current account mode, bot mode, XAUUSD positions, bridge health, and task principal before mutation.
4. Require `PAUSE` and `XAUUSD positions = 0` for the one-time old-runner -> broker migration.
5. Deploy source/build.
6. Re-register/update `XAUUSD-Phase7C-Executors` and broker ACLs once under Administrator.
7. End the old in-memory task runner and start the new broker exactly once during migration.
8. Verify broker heartbeat and `IDLE / executors STOPPED / PAUSE`.
9. Verify Web START reaches `READY / PAUSE`.
10. Verify Web STOP returns to `IDLE` while the SYSTEM task/broker stays alive.
11. Change a safe DEMO lot setting, confirm `restartRequired=true`, issue Web RESTART, then confirm active lot equals configured lot and `restartRequired=false`.
12. Only after readiness verification may the user enable AUTO manually.

No LIVE order is generated during deployment validation.

## 25. Acceptance criteria

The implementation is acceptable only when all are true:
- API token remains non-elevated.
- Scheduled Task remains SYSTEM + Highest.
- SYSTEM broker remains alive independently of executor state.
- Web can START, STOP, and RESTART without direct SYSTEM task/process control.
- broker request surface is closed, ACL-bounded, and cannot execute arbitrary commands.
- STOP leaves broker alive and executors IDLE.
- START after STOP works without Administrator interaction.
- lot changes can be applied by Web RESTART and active lot reflects new values.
- Web cannot STOP/RESTART while an XAUUSD position is open or position state is unverifiable.
- LIVE executor START does not require ARM, but LIVE AUTO still cannot bypass session ARM.
- every lifecycle/start/recovery transition ends in PAUSE; AUTO is always explicit.
- request handling is idempotent and auditable.
- existing Trend/Sideway/Telegram trading contracts remain unchanged.
