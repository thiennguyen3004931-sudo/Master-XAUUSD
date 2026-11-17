# M4-A Mobile Secure Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tailnet-only mobile action broker that allows exactly AUTO / SEMI / TREND / SIDEWAY / PAUSE and canonical LIVE ARM / DISARM from the existing Phase7C mobile page without exposing API 3711, MT5 bridge 8765, lifecycle controls, or arbitrary mutation paths.

**Architecture:** Add a new `@xauusd/mobile-gateway` workspace that preserves the accepted M2/M3 read-only proxy on `127.0.0.1:5791` and introduces only bounded `/__m4/*` endpoints. The gateway authenticates `Tailscale-User-Login`, validates the exact HTTPS Origin, maps seven fixed actions to canonical localhost-only Phase7C control paths, keeps ARM/DISARM preflight tokens only in server memory, and records non-secret audit events. `MODE_AUTO` must use the same canonical AUTO activation service as the current Web control center (`/api/v1/phase7c-auto-activation/enable`); it must never call `/api/v1/phase7c/bot-mode` directly. The React mobile page calls only same-origin `/__m4/*` for mutation.

**Tech Stack:** Node.js 24, CommonJS runtime modules for the Windows gateway, Vitest 2.1.x, React 19, MUI 7, TanStack Query 5, TypeScript 6 for Web, pnpm 10.18.0, Turbo 2.x, PowerShell 5+/7, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-13-mobile-secure-control-m4a-design.md`

## Global Constraints

- Approved mutation allowlist is exactly `MODE_AUTO`, `MODE_SEMI`, `MODE_TREND`, `MODE_SIDEWAY`, `MODE_PAUSE`, `ARM_LIVE`, `DISARM_LIVE`.
- `MODE_AUTO` calls only `POST /api/v1/phase7c-auto-activation/enable`; AUTO readiness is read from `GET /api/v1/phase7c-auto-activation/status`.
- `MODE_AUTO` must never call `/api/v1/phase7c/bot-mode` directly and must not duplicate AUTO safety checks in the gateway.
- `MODE_SEMI`, `MODE_TREND`, `MODE_SIDEWAY`, and `MODE_PAUSE` call `POST /api/v1/phase7c/bot-mode` with fixed server-side source `mobile-control-center`.
- LIVE ARM/DISARM must reuse `/api/v1/phase7c-live-arm-control/{capability,preflight,execute,status}` and never reimplement canonical safety logic.
- Canonical ARM preflight tokens never leave gateway memory and never appear in browser storage, response bodies, audit, or logs.
- Mutation authorization requires exact `Tailscale-User-Login` allowlist membership and exact deployment-configured HTTPS Origin.
- Gateway production bind remains exactly `127.0.0.1:5791`.
- Web remains `127.0.0.1:5717`; API remains `127.0.0.1:3711`; MT5 bridge remains `127.0.0.1:8765`.
- Tailscale Funnel and router/NAT port forwarding remain forbidden.
- Remote lifecycle start/stop/restart, account switch, lot settings, order entry/close, position mutation, and arbitrary API proxying remain forbidden.
- Source implementation/CI/review must keep `BOT_MUTATION=NONE`, `MT5_MUTATION=NONE`, `PHASE7C_RUNTIME_MUTATION=NONE`, `ORDER_MUTATION=NONE`, `POSITION_MUTATION=NONE`, `LIVE_TEST_ORDER=NONE`.
- Production rollout is a separate gated phase after merge; only the mobile gateway files/config and exact mobile-gateway task runtime may change during rollout.
- No order is opened solely to test M4-A.

## File Structure

- `apps/mobile-gateway/package.json` — workspace scripts and Vitest dependency.
- `apps/mobile-gateway/gateway.js` — production entry point; loads config and starts localhost server.
- `apps/mobile-gateway/server.cjs` — HTTP routing, identity/origin checks, existing M2 GET/HEAD proxy, bounded M4 endpoints.
- `apps/mobile-gateway/m4-contract.cjs` — immutable action enum, risk classification, strict body parsing.
- `apps/mobile-gateway/canonical-client.cjs` — fixed canonical localhost calls; exports no generic request primitive.
- `apps/mobile-gateway/transaction-store.cjs` — in-memory ARM/DISARM secret transaction + non-secret status lifecycle.
- `apps/mobile-gateway/audit.cjs` — append-only JSONL audit with secret exclusion.
- `apps/mobile-gateway/m4-action-broker.cjs` — mode/AUTO/ARM/DISARM orchestration.
- `apps/mobile-gateway/gateway.config.example.json` — non-secret schema example.
- `apps/mobile-gateway/test/*.test.mjs` — M2 regression, contract, client, transactions, audit, HTTP security.
- `apps/web/src/mobile-m4-control.ts` — same-origin browser client.
- `apps/web/src/mobile-m4-control.test.ts` — browser client contract tests.
- `apps/web/src/pages/Phase7CMobileReadOnlyPage.tsx` — preserve current read-only cards and add bounded M4 controls.
- `apps/web/package.json` / `pnpm-lock.yaml` — Web test command/dependency and new workspace lock importer.
- `scripts/test-phase7c-mobile-m4a-source-contract.mjs` — static forbidden-surface/source assertions.
- `scripts/preflight-phase7c-mobile-m4a-local.ps1` — read-only production preflight.
- `scripts/deploy-phase7c-mobile-m4a-local.ps1` — gateway-only bounded deployment.
- `scripts/rollback-phase7c-mobile-m4a-local.ps1` — gateway-only rollback.
- `.github/workflows/phase7c-mobile-secure-control-m4a-ci.yml` — dedicated CI.

---

### Task 1: Canonicalize the accepted M2/M3 gateway as a tested workspace

**Files:**
- Create: `apps/mobile-gateway/package.json`
- Create: `apps/mobile-gateway/gateway.js`
- Create: `apps/mobile-gateway/server.cjs`
- Create: `apps/mobile-gateway/gateway.config.example.json`
- Create: `apps/mobile-gateway/test/server-readonly.test.mjs`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes config `{ listenHost, listenPort, webOrigin, apiOrigin, allowedUsers, allowedOrigin, auditPath }`.
- Produces `createMobileGatewayServer({ config, broker, fetchImpl })` and preserves accepted M2 behavior: `GET /__m2/health`, authenticated GET/HEAD proxy to Web, denial of non-read-only methods unless an exact M4 route owns them.

- [ ] **Step 1: Add workspace metadata**

Create `apps/mobile-gateway/package.json`:

```json
{
  "name": "@xauusd/mobile-gateway",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "node --check gateway.js && node --check server.cjs",
    "lint": "node --check gateway.js && node --check server.cjs",
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^2.1.9"
  }
}
```

Run:

```bash
pnpm install --lockfile-only
```

Expected: `pnpm-lock.yaml` gains an `apps/mobile-gateway` importer without unrelated dependency churn.

- [ ] **Step 2: Write failing M2/M3 regression tests**

Use an ephemeral Web upstream and require:

```js
expect(await request("GET", "/__m2/health")).toMatchObject({ status: 200 });
expect(await request("GET", "/phase7c-mobile", trustedHeaders)).toMatchObject({ status: 200 });
expect(await request("HEAD", "/phase7c-mobile", trustedHeaders)).toMatchObject({ status: 200 });
expect(await request("GET", "/phase7c-mobile")).toMatchObject({ status: 403 });
expect(await request("POST", "/phase7c-mobile", trustedHeaders)).toMatchObject({ status: 405 });
```

Also assert production config accepts only `listenHost: "127.0.0.1"`.

- [ ] **Step 3: Verify RED**

```bash
pnpm --filter @xauusd/mobile-gateway test
```

Expected: FAIL because the canonical workspace/server implementation is not present yet.

- [ ] **Step 4: Implement only accepted read-only behavior**

`server.cjs` uses Node `http`, serves `/__m2/health`, proxies only GET/HEAD to fixed `webOrigin`, requires `tailscale-user-login` for proxied application routes, strips hop-by-hop and Tailscale identity headers before upstream forwarding, and rejects other methods with 405.

`gateway.js` loads runtime config from:

```text
C:\ProgramData\XAUUSD-AI-MASTER\mobile-readonly-gateway\gateway.config.json
```

Production startup must throw if `listenHost !== "127.0.0.1"`.

- [ ] **Step 5: Verify GREEN**

```bash
pnpm --filter @xauusd/mobile-gateway test
pnpm --filter @xauusd/mobile-gateway build
```

- [ ] **Step 6: Commit**

```bash
git add apps/mobile-gateway pnpm-lock.yaml
git commit -m "feat: canonicalize mobile gateway source"
```

---

### Task 2: Add the fixed M4 contract and canonical localhost client

**Files:**
- Create: `apps/mobile-gateway/m4-contract.cjs`
- Create: `apps/mobile-gateway/canonical-client.cjs`
- Create: `apps/mobile-gateway/test/m4-contract.test.mjs`
- Create: `apps/mobile-gateway/test/canonical-client.test.mjs`
- Modify: `apps/mobile-gateway/package.json`

**Interfaces:**
- Produces `REMOTE_ACTIONS`, `parseActionBody(input)`, `isRiskIncreasing(action)`.
- Produces `createCanonicalClient({ apiOrigin, fetchImpl, timeoutMs })` with only: `getBotMode`, `setBotMode`, `getAutoActivationStatus`, `enableAuto`, `getArmCapability`, `createArmPreflight`, `executeArm`, `getArmStatus`.

- [ ] **Step 1: Write RED action-contract tests**

Require exact actions:

```js
[
  "MODE_AUTO",
  "MODE_SEMI",
  "MODE_TREND",
  "MODE_SIDEWAY",
  "MODE_PAUSE",
  "ARM_LIVE",
  "DISARM_LIVE"
]
```

Reject unknown actions and any request object containing forbidden keys `url`, `path`, `method`, `source`, `body`, `headers`, `apiOrigin`, or `mt5Origin`.

Accepted bodies are only:

```js
{ action: "MODE_TREND", confirmation: "MODE_TREND" }
{ action: "ARM_LIVE", phase: "PREFLIGHT" }
{ action: "ARM_LIVE", phase: "EXECUTE", transactionId: "tx-1", confirmation: "ARM_LIVE" }
```

with equivalent DISARM shape. Mode confirmation must exactly equal action; ARM/DISARM execute confirmation must exactly equal action.

- [ ] **Step 2: Write RED canonical mapping tests**

Inject `fetchImpl`, capture every call, and require these fixed endpoints:

```text
GET  http://127.0.0.1:3711/api/v1/phase7c/bot-mode
POST http://127.0.0.1:3711/api/v1/phase7c/bot-mode
GET  http://127.0.0.1:3711/api/v1/phase7c-auto-activation/status
POST http://127.0.0.1:3711/api/v1/phase7c-auto-activation/enable
GET  http://127.0.0.1:3711/api/v1/phase7c-live-arm-control/capability
POST http://127.0.0.1:3711/api/v1/phase7c-live-arm-control/preflight
POST http://127.0.0.1:3711/api/v1/phase7c-live-arm-control/execute
GET  http://127.0.0.1:3711/api/v1/phase7c-live-arm-control/status?requestId=<URL-encoded-id>
```

Require `enableAuto()` to POST fixed `{}` to `/phase7c-auto-activation/enable` and assert it never calls `/phase7c/bot-mode`.

Require non-AUTO mappings:

```js
MODE_SEMI    -> { mode: "SEMI", source: "mobile-control-center" }
MODE_TREND   -> { mode: "TREND", source: "mobile-control-center" }
MODE_SIDEWAY -> { mode: "SIDEWAY", source: "mobile-control-center" }
MODE_PAUSE   -> { mode: "PAUSE", source: "mobile-control-center" }
```

- [ ] **Step 3: Run RED**

```bash
pnpm --filter @xauusd/mobile-gateway test
```

Expected: contract/client tests FAIL because modules are absent.

- [ ] **Step 4: Implement strict action parser**

Use immutable allowed-key sets per action/phase. Reject unknown keys instead of ignoring them. Do not export any way for the caller to select upstream path/method/body/source.

- [ ] **Step 5: Implement canonical client**

The client builds URLs only from fixed constants plus URL-encoded canonical request IDs. Use `AbortSignal.timeout(timeoutMs)` and parse bounded JSON errors. Never retry POST mutations.

- [ ] **Step 6: GREEN + commit**

```bash
pnpm --filter @xauusd/mobile-gateway test
pnpm --filter @xauusd/mobile-gateway build
git add apps/mobile-gateway
git commit -m "feat: add fixed M4 canonical client"
```

---

### Task 3: Add ARM/DISARM transaction state and action broker

**Files:**
- Create: `apps/mobile-gateway/transaction-store.cjs`
- Create: `apps/mobile-gateway/m4-action-broker.cjs`
- Create: `apps/mobile-gateway/test/mode-actions.test.mjs`
- Create: `apps/mobile-gateway/test/arm-transactions.test.mjs`

**Interfaces:**
- `createTransactionStore({ now, randomUUID })` returns `createPending`, `consumePendingForExecute`, `createStatusRecord`, `getStatusRecord`, `deleteExpired`.
- `createM4ActionBroker({ canonical, transactions, audit, now })` returns `getState(identity)`, `handleAction(identity, body)`, `getTransactionStatus(identity, transactionId)`.

- [ ] **Step 1: Write RED mode broker tests**

Require:

```text
MODE_AUTO    -> canonical.enableAuto() only
MODE_SEMI    -> canonical.setBotMode("SEMI", "mobile-control-center")
MODE_TREND   -> canonical.setBotMode("TREND", "mobile-control-center")
MODE_SIDEWAY -> canonical.setBotMode("SIDEWAY", "mobile-control-center")
MODE_PAUSE   -> canonical.setBotMode("PAUSE", "mobile-control-center")
```

Assert `MODE_AUTO` never invokes `canonical.setBotMode()`.

Require `getState()` to combine fixed read-only calls: `getBotMode()`, `getAutoActivationStatus()`, and `getArmCapability()`.

Require canonical rejection/timeout to propagate as failure/ambiguous, never success.

- [ ] **Step 2: Write RED ARM preflight tests**

Fake canonical preflight:

```js
{
  approved: true,
  action: "ARM_LIVE",
  bridgeSessionId: "session-1",
  preflightToken: "SECRET-CANONICAL-TOKEN",
  expiresAt: now + 45_000,
  checks: { botPaused: true },
  blockedBy: []
}
```

Require browser result to contain a cryptographically random gateway `transactionId`, approved/checks/blockedBy/expiresAt, but never `preflightToken`.

Pending record must bind identity + action + canonical token and expire at `Math.min(canonicalExpiresAt, now + 45_000)`.

- [ ] **Step 3: Write RED execute-gate tests**

Reject before canonical execute on missing transaction, expired transaction, wrong identity, wrong action, wrong confirmation, or second use.

On valid execute, `consumePendingForExecute()` deletes the secret-bearing pending record immediately and returns the secret once. Then call canonical execute exactly once with:

```js
{
  action: "ARM_LIVE",
  preflightToken: "SECRET-CANONICAL-TOKEN",
  confirmation: "ARM_LIVE"
}
```

Store only non-secret status metadata: gateway transaction ID, identity, action, canonical request ID, startedAt, expiresAt no later than 10 minutes.

- [ ] **Step 4: Write RED status tests**

Only the same identity may poll a gateway-owned transaction. Require:

- canonical `RUNNING` -> gateway `RUNNING`;
- ARM canonical `PASS` and `finalArmStatus="ARMED"` -> success;
- ARM PASS but final state mismatch -> `AMBIGUOUS`;
- DISARM PASS and final state `DISARMED` -> success;
- canonical FAIL -> failure;
- network/timeout/unknown response -> `AMBIGUOUS`.

- [ ] **Step 5: Implement transaction store and broker**

Use `crypto.randomUUID()`, in-memory Maps, no persistence of canonical tokens. Gateway restart invalidates pending confirmations naturally.

ARM/DISARM preflight must use canonical `getArmCapability()` + `createArmPreflight(action)`; approval remains canonical. AUTO uses only `enableAuto()`.

- [ ] **Step 6: GREEN + commit**

```bash
pnpm --filter @xauusd/mobile-gateway test
pnpm --filter @xauusd/mobile-gateway build
git add apps/mobile-gateway
git commit -m "feat: add M4 action broker transactions"
```

---

### Task 4: Add append-only audit with risk-direction failure semantics

**Files:**
- Create: `apps/mobile-gateway/audit.cjs`
- Create: `apps/mobile-gateway/test/audit.test.mjs`
- Modify: `apps/mobile-gateway/m4-action-broker.cjs`

**Interfaces:**
- `createAuditSink({ auditPath, appendFileSync, mkdirSync })` returns `append(event)`.
- Audit phases are `ATTEMPT` and `RESULT`; events never accept arbitrary raw request headers/body.

- [ ] **Step 1: Write RED audit-shape tests**

Require fields:

```js
{
  version: 1,
  timestamp: expect.any(String),
  identity: "thiennguyen300493@gmail.com",
  action: "MODE_TREND",
  phase: "ATTEMPT",
  transactionId: null,
  canonicalTarget: "PHASE7C_BOT_MODE"
}
```

For AUTO require `canonicalTarget: "PHASE7C_AUTO_ACTIVATION"`.

Stringify every audit line and assert absence of fake canonical token, `preflightToken`, `canonicalToken`, `authorization`, `cookie`, and full incoming headers.

- [ ] **Step 2: Write RED audit-failure tests**

Inject an audit sink that throws. Require **no canonical mutation** for risk-increasing actions:

```text
MODE_AUTO
MODE_SEMI
MODE_TREND
MODE_SIDEWAY
ARM_LIVE execute
```

Require `MODE_PAUSE` and `DISARM_LIVE` to remain reachable and return `auditDegraded=true`.

- [ ] **Step 3: Implement audit sink and broker ordering**

Risk-increasing ordering:

```text
mandatory ATTEMPT audit
-> canonical mutation once
-> best-effort RESULT audit
```

Risk-reducing ordering:

```text
best-effort ATTEMPT audit
-> canonical mutation once
-> best-effort RESULT audit
```

Append exactly one JSON object plus newline. Request handling never rotates/deletes audit files.

- [ ] **Step 4: GREEN + commit**

```bash
pnpm --filter @xauusd/mobile-gateway test
git add apps/mobile-gateway
git commit -m "feat: audit M4 remote control"
```

---

### Task 5: Expose only bounded M4 HTTP routes

**Files:**
- Modify: `apps/mobile-gateway/server.cjs`
- Modify: `apps/mobile-gateway/gateway.js`
- Create: `apps/mobile-gateway/test/m4-http.test.mjs`

**Interfaces:**
- `GET /__m4/state` — authenticated bounded state only.
- `POST /__m4/action` — sole mutation endpoint.
- `GET /__m4/status?transactionId=<gateway-id>` — authenticated bounded transaction status.

- [ ] **Step 1: Write RED identity/origin tests**

With test config:

```js
{
  listenHost: "127.0.0.1",
  allowedUsers: ["thiennguyen300493@gmail.com"],
  allowedOrigin: "https://emlvt-dt-1.taila2e32b.ts.net:8443",
  apiOrigin: "http://127.0.0.1:3711",
  webOrigin: "http://127.0.0.1:5717"
}
```

Mutation must return 403 with zero broker calls when identity is missing/unauthorized or Origin is missing/mismatched. Authorized identity + exact Origin may reach broker.

Production config validation must fail closed when allowed users are empty, allowed Origin is not HTTPS, listen host is not `127.0.0.1`, or API/Web origins are non-loopback.

- [ ] **Step 2: Write RED HTTP-surface tests**

Require:

```text
POST /__m4/action -> only authorized mutation path
GET /__m4/action -> 405
PUT/PATCH/DELETE/OPTIONS /__m4/action -> 405
POST /api/v1/... -> 405 and never proxied
GET /__m4/state -> bounded authenticated state
GET /__m4/status -> only gateway transaction IDs
```

Bodies with custom URL/path/method/source/body/header fields must fail before broker/canonical calls.

- [ ] **Step 3: Add strict JSON input handling**

Accept only `application/json`, maximum 8 KiB. Malformed JSON -> 400. Oversized -> 413. No query/form mutation.

- [ ] **Step 4: Wire production entry point**

`gateway.js` creates config, canonical client, transaction store, audit sink, broker, then server exactly once. No generic API token is introduced.

- [ ] **Step 5: Verify M2 regression + M4 GREEN**

```bash
pnpm --filter @xauusd/mobile-gateway test
pnpm --filter @xauusd/mobile-gateway build
```

- [ ] **Step 6: Commit**

```bash
git add apps/mobile-gateway
git commit -m "feat: expose bounded M4 gateway routes"
```

---

### Task 6: Add same-origin browser client and bounded mobile UI

**Files:**
- Create: `apps/web/src/mobile-m4-control.ts`
- Create: `apps/web/src/mobile-m4-control.test.ts`
- Modify: `apps/web/src/pages/Phase7CMobileReadOnlyPage.tsx`
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Export `getMobileM4State`, `executeMobileMode`, `preflightMobileArm`, `executeMobileArm`, `getMobileArmStatus`.
- All mutation/status URLs are same-origin `/__m4/*`; no `127.0.0.1:3711` fallback exists in this module.

- [ ] **Step 1: Add Web Vitest command and RED client tests**

Add:

```json
"test": "vitest run"
```

and dev dependency `"vitest": "^2.1.9"`.

Inject fetch and require exact requests:

```text
GET  /__m4/state
POST /__m4/action
GET  /__m4/status?transactionId=<URL-encoded-gateway-id>
```

Mode request:

```json
{ "action": "MODE_TREND", "confirmation": "MODE_TREND" }
```

ARM preflight:

```json
{ "action": "ARM_LIVE", "phase": "PREFLIGHT" }
```

ARM execute:

```json
{
  "action": "ARM_LIVE",
  "phase": "EXECUTE",
  "transactionId": "gateway-transaction",
  "confirmation": "ARM_LIVE"
}
```

- [ ] **Step 2: RED**

```bash
pnpm --filter @xauusd/web test
```

Expected: FAIL because `mobile-m4-control.ts` is absent.

- [ ] **Step 3: Implement same-origin client**

Use bounded JSON parsing and error propagation. Never use `local-control-request.ts` or direct `CONTROL_DIRECT` for mobile mutations.

- [ ] **Step 4: Extend only the existing mobile page**

Preserve current read-only cards. Add one control card containing only:

```text
AUTO  SEMI  TREND  SIDEWAY  PAUSE
ARM LIVE / DISARM LIVE
```

State card must display current mode, current LIVE ARM state, and AUTO readiness/blocked reason supplied by `/__m4/state` from canonical AUTO activation status.

Mode actions require one `window.confirm()` showing current -> requested mode. AUTO still only sends `MODE_AUTO`; browser never chooses canonical URL/body.

ARM flow:

1. `KIỂM TRA ARM LIVE` -> preflight.
2. Display canonical checks/blocked reasons.
3. Enable `ARM LIVE` only for approved, unexpired gateway transaction.
4. Confirm that bot must be PAUSE, ARM does not enable AUTO, and ARM sends no order.
5. Execute transaction and poll `/__m4/status`.
6. Only canonical PASS + correct final state renders success.

DISARM flow: one confirmation -> preflight -> execute approved gateway transaction -> status polling.

No lifecycle/order/position/account/lot controls are added.

- [ ] **Step 5: GREEN/build + commit**

```bash
pnpm --filter @xauusd/web test
pnpm --filter @xauusd/web build
git add apps/web pnpm-lock.yaml
git commit -m "feat: add M4 controls to mobile page"
```

---

### Task 7: Add source contract, production preflight, gateway-only deploy, and rollback

**Files:**
- Create: `scripts/test-phase7c-mobile-m4a-source-contract.mjs`
- Create: `scripts/preflight-phase7c-mobile-m4a-local.ps1`
- Create: `scripts/deploy-phase7c-mobile-m4a-local.ps1`
- Create: `scripts/rollback-phase7c-mobile-m4a-local.ps1`

**Interfaces:**
- Source contract is static/non-mutating.
- Preflight is read-only.
- Deploy may mutate only gateway files/config and exact task `\XAUUSD-AI-MASTER\Phase7C-Mobile-Readonly-Gateway` runtime.
- Rollback restores previous gateway bundle and restarts only that exact task.

- [ ] **Step 1: Write RED static source contract**

Require source to contain:

```text
MODE_AUTO MODE_SEMI MODE_TREND MODE_SIDEWAY MODE_PAUSE ARM_LIVE DISARM_LIVE
/__m4/action
Tailscale-User-Login
/api/v1/phase7c-auto-activation/enable
/api/v1/phase7c-auto-activation/status
/api/v1/phase7c-live-arm-control
```

Require source to prove AUTO does not map to `/api/v1/phase7c/bot-mode` and reject forbidden remote surfaces. Fail if remote-control implementation contains lifecycle start/stop, arbitrary MT5 order/position routes, Funnel enablement, or non-loopback 3711/8765 exposure.

- [ ] **Step 2: Implement read-only production preflight**

It must print:

```text
READ_ONLY=TRUE
HTTP_METHODS=GET_ONLY
GIT_MUTATION=NONE
TASK_MUTATION=NONE
PROCESS_MUTATION=NONE
SERVE_MUTATION=NONE
FUNNEL_MUTATION=NONE
MODE_MUTATION=NONE
ARM_MUTATION=NONE
ORDER_MUTATION=NONE
POSITION_MUTATION=NONE
LIVE_TEST_ORDER=NONE
```

Required `-ExpectedCommit` parameter. Checks:

- repo branch/source clean and exact accepted commit;
- expected gateway source hashes computed/printed;
- scheduled task exists, SYSTEM, AtStartup, Node + ProgramData gateway path;
- live gateway `/__m2/health` 200;
- first M4 rollout expects existing M3 gateway SHA256 `F4DC53D3E22738D26C762C78687ADBC4D20AD3DFAE8397C3C3A981884E8DB79A`; later accepted M4 hash may be supplied explicitly;
- Tailscale backend Running + self Online;
- Serve remains `8443 -> 127.0.0.1:5791 (tailnet only)`;
- public Funnel false;
- ports 3711/5717/5791/8765 have zero non-loopback listeners.

- [ ] **Step 3: Implement bounded deploy**

Required parameters: `-ExpectedCommit`, `-AllowedUser`, `-AllowedOrigin`.

Exact mutation sequence:

```text
run all preflight gates
backup current ProgramData gateway bundle + hashes
copy accepted runtime files to staging
write non-secret gateway.config.json to staging
node --check staged runtime
stop exact mobile gateway Scheduled Task
atomic swap staged bundle into ProgramData gateway directory
start exact mobile gateway Scheduled Task
verify new process owner SYSTEM and listener 127.0.0.1:5791
verify /__m2/health=200
verify no-identity app GET=403
verify non-M4 POST=405
verify Serve unchanged, Funnel false
verify 3711/5717/5791/8765 loopback-only
```

Forbidden in deploy: Tailscale restart/up/login/logout, Windows reboot, API/MT5/Phase7C lifecycle/executor restart, mode mutation, ARM mutation, order/position mutation.

- [ ] **Step 4: Implement rollback**

Rollback stops only the exact gateway task, restores backup gateway bundle/config, starts only the same gateway task, then reruns M2/M3 network/security gates. It must never restart Tailscale/API/MT5/Phase7C or mutate mode/ARM/order/position.

- [ ] **Step 5: GREEN static contract + commit**

```bash
node scripts/test-phase7c-mobile-m4a-source-contract.mjs
git add scripts
git commit -m "feat: add bounded M4 rollout scripts"
```

Expected: `PHASE7C_MOBILE_M4A_SOURCE_CONTRACT=PASS`.

---

### Task 8: Add dedicated CI and source-only acceptance

**Files:**
- Create: `.github/workflows/phase7c-mobile-secure-control-m4a-ci.yml`

**Interfaces:**
- CI is source-only; no production/network mutation.

- [ ] **Step 1: Add path-scoped workflow**

Use `permissions: contents: read`, pnpm 10.18.0, Node 24. Required commands:

```bash
pnpm install --frozen-lockfile
pnpm --filter @xauusd/mobile-gateway test
pnpm --filter @xauusd/mobile-gateway build
pnpm --filter @xauusd/web test
pnpm --filter @xauusd/web build
pnpm --filter @xauusd/api build
node scripts/test-phase7c-mobile-m4a-source-contract.mjs
```

- [ ] **Step 2: Run full source verification locally/CI**

Require all commands above GREEN. API build proves canonical interfaces still compile; API source should remain unchanged.

- [ ] **Step 3: Scope/secret review**

Reject the implementation if it touches strategy engine, MT5 broker logic, LIVE ARM service safety code, AUTO activation service safety code, lifecycle service, account switching, lot settings, or order/position execution.

The implementation must not commit the real operator email as a source default; `gateway.config.example.json` uses `operator@example.com`. The real allowlisted user is passed only at deployment/runtime config.

If an API source change becomes necessary, stop and return to design review rather than expanding scope silently.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/phase7c-mobile-secure-control-m4a-ci.yml
git commit -m "ci: verify M4 mobile secure control"
```

---

### Task 9: PR review gate before production mutation

**Files:**
- Review-only unless defects are found.

- [ ] **Step 1: Compare implementation branch with current main**

Record base/head SHA and every changed filename. Every file must map to this plan/spec.

- [ ] **Step 2: Open PR with explicit safety statement**

PR body must include:

```text
BOT_MUTATION=NONE
MT5_MUTATION=NONE
PHASE7C_RUNTIME_MUTATION=NONE
ORDER_MUTATION=NONE
POSITION_MUTATION=NONE
LIVE_TEST_ORDER=NONE
3711_REMOTE_EXPOSURE=NONE
8765_REMOTE_EXPOSURE=NONE
FUNNEL=OFF_UNCHANGED
```

- [ ] **Step 3: Require CI GREEN and review patches**

Specifically verify:

- exactly seven actions;
- AUTO uses only canonical AUTO activation enable/status paths;
- AUTO never directly uses bot-mode route;
- non-AUTO modes use fixed server-side mode/source;
- ARM token never exits gateway memory;
- identity/origin fail closed;
- risk-direction audit semantics are correct;
- mutation POSTs are not retried;
- gateway remains localhost-only;
- M2 read-only behavior remains tested.

- [ ] **Step 4: Merge only after all gates pass**

Record merged `main` commit/tree. CI does not deploy production.

---

### Task 10: Post-merge read-only preflight and bounded production rollout

**Files:**
- Execute merged scripts only after separate explicit rollout approval.

**Interfaces:**
- Consumes accepted merged commit and current M3 runtime.
- Produces an M4 gateway runtime while bot/MT5/Phase7C processes remain untouched.

- [ ] **Step 1: Prove local production source equals accepted merged source**

Run merged preflight with required `-ExpectedCommit` set to the accepted merged main SHA. Stop on any mismatch. Do not repair unrelated runtime drift inside this rollout.

- [ ] **Step 2: Capture pre-rollout evidence**

Record gateway PID/owner/hash, task definition/state, Tailscale Serve/Funnel state, ports 3711/5717/5791/8765, read-only bot mode/ARM status, and read-only XAUUSD position count.

- [ ] **Step 3: Deploy gateway only**

Invoke deploy script with runtime values:

```text
AllowedUser=thiennguyen300493@gmail.com
AllowedOrigin=https://emlvt-dt-1.taila2e32b.ts.net:8443
```

Mutation scope is exactly ProgramData gateway files/config + exact gateway Scheduled Task stop/start.

- [ ] **Step 4: Run local non-mutating security acceptance first**

Verify health, no-identity rejection, invalid-Origin rejection, unknown-action rejection, forbidden-method rejection, Serve/Funnel state, and port isolation without executing mode or ARM mutation.

- [ ] **Step 5: Validate phone rendering**

Open:

```text
https://emlvt-dt-1.taila2e32b.ts.net:8443/phase7c-mobile
```

Verify current mode, AUTO readiness, ARM state, and exactly the seven approved controls are visible.

- [ ] **Step 6: Functional control acceptance only in an explicit safe operator window**

Preferred safe sequence when runtime state permits:

```text
MODE_PAUSE -> verify canonical PAUSE
DISARM_LIVE if currently armed -> verify canonical DISARM PASS
ARM preflight only -> verify canonical checks/blocked reasons, token remains server-side
ARM execute only after explicit operator approval and canonical preflight PASS
```

Do not live-test AUTO/TREND/SIDEWAY/SEMI when those actions could open a new position. Their route/body mappings are proven by TDD/CI; live functional mutation is deferred unless entry is independently and safely blocked by canonical runtime.

- [ ] **Step 7: Final attestation**

Require:

```text
M4_ALLOWED_ACTIONS=7
AUTO_CANONICAL_PATH=PHASE7C_AUTO_ACTIVATION
DIRECT_3711_REMOTE_EXPOSURE=FALSE
DIRECT_8765_REMOTE_EXPOSURE=FALSE
PUBLIC_FUNNEL_ACTIVE=FALSE
GATEWAY_BIND=127.0.0.1:5791
TAILNET_ONLY=TRUE
BOT_PROCESS_MUTATION=NONE
MT5_PROCESS_MUTATION=NONE
PHASE7C_LIFECYCLE_MUTATION=NONE
LIVE_TEST_ORDER=NONE
PHONE_M4_ACCEPTANCE=PASS
```

Any failed/ambiguous gate triggers gateway-only rollback to the accepted M3 read-only bundle.

## Plan Self-review Record

- Spec coverage: PASS — network, identity/origin, seven-action allowlist, corrected AUTO service path, ARM transaction secrecy, audit, UI, CI, rollout, and rollback all have implementation tasks.
- Placeholder scan: PASS — no TBD/TODO/"implement later" steps remain.
- Type/interface consistency: PASS — broker/client/store function names are defined before dependent tasks use them; browser APIs map only to `/__m4/*`.
- Safety correction: PASS — every AUTO step now uses `/api/v1/phase7c-auto-activation/{status,enable}` and explicitly forbids direct AUTO use of `/api/v1/phase7c/bot-mode`.
