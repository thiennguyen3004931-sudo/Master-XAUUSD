# M4-A Mobile Secure Control — Design Specification

Date: 2026-09-13  
Status: DESIGN APPROVED — canonical AUTO-path correction awaiting acknowledgment  
Scope: mobile remote control through the existing Tailscale-only gateway  
Production mutation during design/spec work: NONE

## 1. Objective

M4-A extends the existing mobile remote-access architecture with a narrowly bounded control surface for Phase 7C. The phone may change operating mode and request LIVE ARM/DISARM, while canonical safety checks, provenance rules, elevated task execution, strategy logic, MT5 ownership, and runtime ownership remain in the existing Phase 7C services.

M4-A is an authenticated action broker, not a second bot-control implementation and not a generic API proxy.

## 2. Approved Remote Actions

The complete mutation allowlist is exactly:

- `MODE_AUTO`
- `MODE_SEMI`
- `MODE_TREND`
- `MODE_SIDEWAY`
- `MODE_PAUSE`
- `ARM_LIVE`
- `DISARM_LIVE`

Explicitly out of scope and denied remotely:

- process/lifecycle start, stop, restart
- direct order open/close
- direct position mutation
- lot/risk-setting mutation
- account switching
- arbitrary API path/method/body
- direct MT5 bridge access
- direct remote access to API 3711 or MT5 8765
- Tailscale Funnel/public Internet exposure

## 3. Canonical Control Paths

M4-A must reuse the production paths already used by the local Web control center. It must not choose a shorter path when a stronger canonical guard exists.

### 3.1 AUTO activation — corrected canonical path

The local Web control center currently activates AUTO through:

- `GET /api/v1/phase7c-auto-activation/status`
- `POST /api/v1/phase7c-auto-activation/enable`

`enablePhase7CAutoFromWeb()` evaluates the canonical AUTO activation gates before setting mode AUTO. The checks include:

- control enabled
- account-mode state valid
- bot currently PAUSE
- runtime ready
- MT5 bridge reachable
- bridge account matches selected account mode
- bridge trading enabled
- terminal trading allowed
- expert/algo trading allowed
- zero open XAUUSD positions
- LIVE ARM satisfied when account mode is LIVE

Only after every canonical AUTO check passes does the service call the bot-mode service with source `web-control-center`.

Therefore `MODE_AUTO` in M4-A must call **only** `POST /api/v1/phase7c-auto-activation/enable`. It must not call `/api/v1/phase7c/bot-mode` directly for AUTO and must not reproduce the AUTO checks inside the gateway.

This correction is stricter than the earlier draft and preserves the actual current local Web safety path.

### 3.2 Non-AUTO mode changes

For `SEMI`, `TREND`, `SIDEWAY`, and `PAUSE`, the canonical mutation path is:

`POST /api/v1/phase7c/bot-mode`

The gateway supplies fixed server-side bodies:

```text
MODE_SEMI    -> { mode: "SEMI",    source: "mobile-control-center" }
MODE_TREND   -> { mode: "TREND",   source: "mobile-control-center" }
MODE_SIDEWAY -> { mode: "SIDEWAY", source: "mobile-control-center" }
MODE_PAUSE   -> { mode: "PAUSE",   source: "mobile-control-center" }
```

The browser cannot choose `source`, canonical path, or arbitrary body fields. Canonical API validation remains authoritative.

### 3.3 LIVE ARM / DISARM

Canonical API prefix:

`/api/v1/phase7c-live-arm-control`

Required canonical sequence:

1. `GET /capability`
2. `POST /preflight`
3. `POST /execute`
4. `GET /status`

The existing Phase7C LIVE ARM service remains the only owner of ARM/DISARM safety logic. M4-A must not reimplement, weaken, cache around, short-circuit, or bypass it.

The existing 45-second canonical preflight-token TTL, bridge-session binding, fresh re-evaluation before execute, elevated task ownership, PAUSE requirement where applicable, LIVE authorization, runtime readiness, and zero-position checks remain authoritative.

## 4. Network Architecture

```text
PHONE
  |
  | Tailscale tailnet only / HTTPS :8443
  v
M4 SECURE GATEWAY
127.0.0.1:5791
  |
  +-- GET/HEAD read-only UI traffic --> 127.0.0.1:5717
  |
  +-- bounded /__m4/* action broker --> 127.0.0.1:3711
```

Non-negotiable network invariants:

- Serve exposes only gateway 5791 through HTTPS 8443.
- Web 5717 remains localhost-only.
- API 3711 remains localhost-only.
- MT5 bridge 8765 remains localhost-only.
- Funnel remains disabled.
- No router/NAT port-forward is introduced.

## 5. Action Broker Model

The phone never sends an upstream URL, canonical method, canonical source value, or canonical request body.

Mutation entry point:

`POST /__m4/action`

The gateway maps a bounded action identifier to a fixed internal canonical operation.

Examples:

```text
MODE_TREND
  -> POST 127.0.0.1:3711/api/v1/phase7c/bot-mode
  -> fixed { mode:"TREND", source:"mobile-control-center" }

MODE_AUTO
  -> POST 127.0.0.1:3711/api/v1/phase7c-auto-activation/enable
  -> fixed {}
```

Unknown actions, unknown fields, arbitrary URL/path/method/source/body fields, lifecycle actions, order actions, position actions, lot actions, and account-switch actions fail closed before any canonical call.

## 6. Identity and Browser Request Trust

M4-A authorizes mutations using the Tailscale Serve identity header `Tailscale-User-Login` plus exact Origin validation.

Production requirements:

- accepted identity must be in an explicit deployment-configured allowlist;
- missing identity -> reject;
- identity outside allowlist -> reject;
- gateway binds exactly `127.0.0.1:5791`;
- production startup fails closed if mutation capability is enabled with an empty/invalid allowlist;
- browser mutation Origin must exactly equal deployment configuration;
- approved current Origin is `https://emlvt-dt-1.taila2e32b.ts.net:8443`;
- Origin supplements identity; it never replaces identity;
- client input cannot choose or override trusted identity.

Tailscale Serve strips client-supplied Tailscale identity headers before adding its trusted headers. The gateway must not forward those identity headers to the Web/API upstreams.

## 7. Confirmation Semantics

### Mode actions

All mode changes use one explicit user confirmation showing current mode, requested mode, and the fact that production bot behavior changes.

### DISARM_LIVE

DISARM uses one user confirmation because it is risk-reducing, but the gateway still performs canonical preflight then canonical execute; no direct state change exists.

### ARM_LIVE

ARM uses two visible stages:

1. request canonical preflight;
2. display canonical checks/blocked reasons;
3. retain the approved canonical token only in gateway memory;
4. require explicit user ARM confirmation;
5. execute with the same unexpired canonical token;
6. poll canonical status by canonical request ID;
7. report success only when canonical status is `PASS` and final ARM state is correct.

Timeout, network failure, unknown response, or final-state mismatch is never displayed as success.

## 8. Gateway API Contract

### Read-only compatibility

Existing M2/M3 GET/HEAD proxy behavior and `/__m2/health` remain intact.

### State

`GET /__m4/state`

Returns only bounded current mobile-control state assembled from fixed canonical read-only calls, including current bot mode, LIVE ARM capability/state, and AUTO activation readiness/status. It is not a generic API proxy.

### Action

`POST /__m4/action`

Mode execute shape:

```json
{ "action": "MODE_TREND", "confirmation": "MODE_TREND" }
```

ARM/DISARM preflight:

```json
{ "action": "ARM_LIVE", "phase": "PREFLIGHT" }
```

ARM/DISARM execute:

```json
{
  "action": "ARM_LIVE",
  "phase": "EXECUTE",
  "transactionId": "gateway-generated-id",
  "confirmation": "ARM_LIVE"
}
```

The canonical preflight token is never returned to the browser.

### Status

`GET /__m4/status?transactionId=<gateway-generated-id>`

This resolves only gateway-owned transaction/status state. It cannot accept arbitrary canonical URLs or request IDs from the browser.

## 9. Server-side Transaction State

ARM/DISARM pending-confirmation state is:

- in memory
- keyed by `crypto.randomUUID()`
- bound to authenticated identity
- bound to action
- single-use for execute
- expires no later than canonical token TTL
- invalidated by gateway restart

On execute, the secret-bearing pending record is consumed immediately. The canonical token is deleted. A separate non-secret status record may retain the gateway transaction ID -> canonical request ID mapping for bounded polling, for no more than 10 minutes.

The gateway never extends canonical token validity.

## 10. Audit Contract

Every remote mutation attempt records non-secret metadata only:

- timestamp
- Tailscale identity
- remote action
- fixed canonical target identifier
- bounded before-state when available
- result classification
- bounded after-state when available
- canonical request ID when available
- gateway transaction ID when applicable

Never log canonical preflight tokens, authorization values, cookies, sensitive environment values, or full secret-bearing headers.

Audit failure semantics:

- risk-increasing `MODE_AUTO`, `MODE_TREND`, `MODE_SIDEWAY`, `MODE_SEMI`, `ARM_LIVE` -> fail closed before mutation if mandatory attempt-audit cannot be persisted;
- risk-reducing `MODE_PAUSE`, `DISARM_LIVE` -> remain reachable under audit degradation and report `auditDegraded`.

## 11. Failure Semantics

- canonical API unreachable -> no success;
- mutation POSTs are never automatically retried;
- unknown/ambiguous canonical result -> `AMBIGUOUS`, not success;
- expired transaction -> new preflight required;
- identity/origin mismatch -> 403 and no canonical call;
- unsupported method -> 405;
- unsupported action/body -> fail closed and no canonical call;
- gateway restart during pending ARM/DISARM -> transaction lost; new preflight required.

Read-only capability/status calls may have bounded retry behavior, but mutation POSTs do not.

## 12. Mobile UI

The existing `/phase7c-mobile` page retains its current read-only operational cards and adds only:

- current mode
- current LIVE ARM state
- AUTO readiness/blocked reason from canonical AUTO activation status
- AUTO / SEMI / TREND / SIDEWAY / PAUSE buttons
- ARM LIVE / DISARM LIVE
- canonical checks, blocked reasons, progress, final status

It must not add lifecycle, process, account-switch, lot-setting, order, position-close, or arbitrary API controls.

Risk-increasing actions are visually distinct. ARM clearly states that PAUSE and all canonical safety gates are prerequisites.

## 13. Source Boundaries

Implementation is split into focused units under `apps/mobile-gateway`, the existing Web mobile page/client, deployment/preflight/rollback scripts, tests, and CI.

No M4 implementation belongs in strategy-engine, MT5 bridge logic, Phase7C execution logic, lifecycle service, account switching, lot settings, or order/position code.

## 14. TDD Acceptance Matrix

Before implementation turns GREEN, tests must prove:

### Allowlist and generic-proxy denial

- exactly seven actions accepted;
- unknown/lifecycle/order/position/lot/account actions rejected;
- custom URL/path/method/source/body fields rejected.

### Identity/origin

- missing identity rejected;
- unauthorized identity rejected;
- authorized identity accepted;
- invalid/missing Origin rejected for mutations;
- production bind remains localhost-only.

### Mode mapping

- `MODE_AUTO` calls only `/api/v1/phase7c-auto-activation/enable`;
- AUTO readiness comes from `/api/v1/phase7c-auto-activation/status`;
- AUTO never calls `/api/v1/phase7c/bot-mode` directly;
- SEMI/TREND/SIDEWAY/PAUSE call exact `/api/v1/phase7c/bot-mode` with fixed mode/source;
- canonical rejection propagates as failure.

### ARM/DISARM

- capability/preflight precede execute;
- raw canonical token never reaches browser/audit;
- wrong identity/action/confirmation, missing/expired/used transaction rejected;
- transaction single-use;
- canonical bridge/session drift rejection propagated;
- success shown only after canonical PASS plus correct final state;
- ambiguous/timeout never shown as success;
- DISARM still uses preflight/execute.

### HTTP surface

- current M2 GET/HEAD proxy remains GREEN;
- `/__m4/action` accepts POST only;
- other mutation methods rejected;
- `/api` mutation proxy unavailable;
- 3711/8765 cannot be selected by browser input.

### Audit

- non-secret attempt/result metadata written;
- tokens absent from audit;
- risk-increasing actions fail closed if mandatory attempt-audit fails;
- PAUSE/DISARM remain available under audit degradation.

## 15. CI Gates

CI must prove:

- mobile-gateway unit/security tests GREEN;
- M2 read-only regression GREEN;
- Web mobile client tests GREEN;
- Web build GREEN;
- API build GREEN without API source changes;
- no secrets;
- no direct 3711/8765 exposure;
- no Funnel enablement;
- no lifecycle/order/position remote mutation path.

## 16. Production Rollout

Rollout is separate from source implementation and occurs only after merge/CI/review.

Required sequence:

1. read-only source/runtime preflight;
2. prove local accepted source equals merged source;
3. prove current M3 gateway/task/Serve/Funnel/port isolation;
4. backup current gateway bundle;
5. stage accepted gateway source + non-secret config;
6. stop/start only the exact mobile-gateway Scheduled Task;
7. local security acceptance;
8. mobile/tailnet acceptance;
9. verify 3711/8765 still localhost-only and Funnel false;
10. functional control acceptance only in explicit safe operator window;
11. final source/runtime attestation.

No rollout step restarts Tailscale, MT5, API, Phase7C lifecycle, broker, strategy executors, or Windows unless a new separately approved recovery task is created.

## 17. Source/Runtime Mutation Boundaries

During implementation/tests/CI/review/merge:

```text
BOT_MUTATION=NONE
MT5_MUTATION=NONE
PHASE7C_RUNTIME_MUTATION=NONE
ORDER_MUTATION=NONE
POSITION_MUTATION=NONE
LIVE_TEST_ORDER=NONE
```

During rollout, only gateway files/config and the exact mobile-gateway task runtime may change.

Functional mode/ARM actions occur only in a separately announced acceptance step. No order is opened solely for M4-A testing.

## 18. Rollback

Rollback restores the previous read-only gateway bundle/config and reloads only the gateway task. It must preserve tailnet-only read access when safe and must not restart API/MT5/Phase7C processes.

If control behavior is ambiguous, remove the remote mutation surface and fall back to the canonical local Web control center.

## 19. Non-goals

M4-A does not add remote lifecycle management, trading commands, copy trading, account switching, lot/risk editing, strategy editing, public access, a replacement for Web/Telegram semantics, or a new ARM/AUTO safety implementation.

## 20. Definition of Done

M4-A is complete only when:

1. Phone can use exactly seven approved actions through Tailscale HTTPS.
2. Client cannot form arbitrary upstream requests.
3. Identity allowlist and exact Origin checks are enforced.
4. AUTO traverses the same canonical AUTO activation service as the current local Web control center.
5. ARM/DISARM traverse full canonical capability/preflight/execute/status.
6. No ARM safety gate is weakened.
7. No lifecycle/order/position/account/lot mutation is remotely reachable.
8. Ports 3711 and 8765 remain localhost-only.
9. Funnel remains disabled.
10. Audit is sufficient and secret-free.
11. TDD/CI pass.
12. Merged source, deployed source, and runtime attestation match.
13. Gateway-only rollback is proven.

## 21. Self-review Record

- Placeholder scan: PASS.
- Internal consistency: PASS after correcting AUTO to the canonical `/phase7c-auto-activation/enable` path used by the existing Web control center.
- Scope check: PASS — one mobile secure-control subsystem.
- Ambiguity check: PASS — exact actions, trusted identity header, Origin, AUTO path, ARM transaction/token handling, network boundaries, and rollback are explicit.
