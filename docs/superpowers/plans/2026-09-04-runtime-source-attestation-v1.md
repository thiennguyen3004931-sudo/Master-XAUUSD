# P1 Runtime Source Attestation V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only runtime provenance layer that proves whether API, lifecycle broker, supervisor, Trend, Sideway, Telegram, and regime-notifier are running from the exact canonical deployment identity, without changing AUTO/ARM/lifecycle/order behavior.

**Architecture:** A PowerShell helper creates or reuses one atomic deployment manifest after existing exact-source guards. Each process generation stamps its actual startup configuration fingerprint and canonical PID; the Node API stamps its own real `process.pid`, aggregates manifest/component/PID/liveness/launcher-hash evidence into `EXACT_MATCH | MISMATCH | STALE | UNKNOWN`, exposes one localhost GET-only endpoint, and the Control Center renders a query-only card. No new daemon or automatic remediation is introduced.

**Tech Stack:** PowerShell 7, Windows PowerShell 5.1, Node.js 24, TypeScript 5.9, Express, React/MUI, TanStack Query, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-04-runtime-source-attestation-v1-design.md`

## Global Constraints

- `P1_V1=READ_ONLY`.
- `AUTO_GATE=NONE`.
- `ARM_GATE=NONE`.
- `START_GATE=NONE`.
- `MODE_MUTATION=NONE`.
- `ARM_MUTATION=NONE`.
- `ORDER_MUTATION=NONE`.
- `POSITION_MUTATION=NONE`.
- `STRATEGY_MUTATION=NONE`.
- `AUTO_RETUNE=NONE`.
- Required components are exactly `api`, `lifecycle-broker`, `supervisor`, `trend`, `sideway`, `telegram`, `regime-notifier`.
- Verdicts are exactly `EXACT_MATCH`, `MISMATCH`, `STALE`, `UNKNOWN`; overall precedence is `MISMATCH` > `UNKNOWN` > `STALE` > `EXACT_MATCH`.
- Ordinary GET handling must not execute Git commands.
- Missing or malformed evidence never becomes `EXACT_MATCH`.
- Attestation write failure is observability failure only: launch callers catch/log and runtime startup continues.
- Runtime JSON writes are atomic.
- No API key, Telegram token, password, ARM token, raw env-file content, or replayable secret enters attestation files, tests, responses, or logs.
- V1 `configFingerprint` contains only stable launch identity: `version`, `accountMode`, `liveExecutionEnabled`, canonical runtime root, control API URL. Mutable lot/TP/strategy settings remain under existing configured-vs-active lifecycle contracts and are not copied into P1.
- Component records compute their fingerprint from the actual immutable startup context passed to that process generation. They do not blindly copy the manifest fingerprint. Therefore a process launched with a different account/launch identity is visible as `MISMATCH` until a canonical deployment generation matches it.
- Source implementation does not mutate the currently running LIVE bot. Post-merge runtime rollout is a separate operator-approved step.

---

## File Structure

### Create

- `scripts/lib/phase7c-runtime-source-attestation.ps1` — PowerShell canonical config identity, SHA-256, atomic manifest/component writer.
- `apps/api/src/services/phase7c-runtime-source-attestation.service.ts` — TypeScript schemas, canonicalization, API self-attestation, current-PID resolution, component/overall verdict aggregation.
- `apps/api/src/services/phase7c-runtime-source-attestation.service.test.ts` — deterministic temp-directory tests with injected liveness/hash readers.
- `apps/web/src/ui/Phase7CRuntimeSourceAttestationCard.tsx` — read-only Control Center card.
- `scripts/test-phase7c-runtime-source-attestation-source.ps1` — PS7/PS5.1 functional + source-safety contract.

### Modify

- `scripts/recover-phase7c-runtime-ready-stable-deploy-local.ps1`
- `scripts/deploy-phase7c-web-ui-local.ps1`
- `scripts/run-phase7c-executor-task-runner-local.ps1`
- `scripts/run-phase7c-executors-local.ps1`
- `scripts/run-phase7b-api-runtime-local.ps1`
- `apps/api/src/index.ts`
- `apps/api/src/routes/phase7c.route.ts`
- `apps/web/src/phase7c-types.ts`
- `apps/web/src/api.ts`
- `apps/web/src/pages/Phase7CControlCenterShellPage.tsx`
- `scripts/test-phase7c-runtime-ready-stable-recovery-deploy-source.ps1`
- `scripts/test-phase7c-web-ui-safe-deploy-source.ps1`
- `scripts/test-phase7c-system-lifecycle-broker-source.ps1`
- `.github/workflows/phase7c-canonical-pr-gate.yml`
- `.github/workflows/phase7c-runtime-ready-stable-recovery-deploy-ci.yml`

### Deliberately unchanged

- `scripts/run-phase7c-trend-controller-local.ps1`
- `scripts/run-phase7c-sideway-controller-local.ps1`
- `scripts/run-phase7c-telegram-mode-controller-local.ps1`
- `scripts/run-phase7c-regime-notifier-local.ps1`
- AUTO/ARM implementation files, order routes, strategy rules, risk/TP business rules.

The supervisor already owns canonical child PID creation, so it can attest on behalf of Trend/Sideway/Telegram/regime-notifier without altering those child scripts.

---

## Locked Type Contracts

Task implementers must use these names/shapes consistently.

```ts
export type Phase7CRuntimeSourceComponentName =
  | "api"
  | "lifecycle-broker"
  | "supervisor"
  | "trend"
  | "sideway"
  | "telegram"
  | "regime-notifier";

export type Phase7CRuntimeSourceVerdict =
  | "EXACT_MATCH"
  | "MISMATCH"
  | "STALE"
  | "UNKNOWN";

export interface Phase7CRuntimeSourceConfigIdentity {
  version: 1;
  accountMode: "DEMO" | "LIVE";
  liveExecutionEnabled: boolean;
  runtimeRoot: string;
  controlApiUrl: string;
}

export interface Phase7CRuntimeSourceDeploymentManifest {
  version: 1;
  deploymentId: string;
  sourceCommit: string;
  sourceTree: string;
  branch: "main";
  worktreeClean: true;
  createdAt: number;
  configFingerprint: string;
}

export interface Phase7CRuntimeSourceComponentAttestation {
  version: 1;
  component: Phase7CRuntimeSourceComponentName;
  deploymentId: string;
  sourceCommit: string;
  sourceTree: string;
  pid: number;
  startedAt: number;
  launcherSha256: string;
  configFingerprint: string;
}

export interface Phase7CRuntimeSourceComponentEvaluationInput {
  component: Phase7CRuntimeSourceComponentName;
  deployment: Phase7CRuntimeSourceDeploymentManifest | null;
  attestation: Phase7CRuntimeSourceComponentAttestation | null;
  currentPid: number | null;
  currentPidAlive: boolean | null;
  attestedPidAlive: boolean | null;
  expectedLauncherSha256: string | null;
  evidenceErrors: string[];
}

export interface Phase7CRuntimeSourceComponentResult {
  component: Phase7CRuntimeSourceComponentName;
  verdict: Phase7CRuntimeSourceVerdict;
  pid: number | null;
  alive: boolean | null;
  sourceCommit: string | null;
  deploymentId: string | null;
  reasonCodes: string[];
}

export interface Phase7CRuntimeSourceAttestationSnapshot {
  version: 1;
  source: "PHASE7C_RUNTIME_SOURCE_ATTESTATION";
  generatedAt: number;
  readOnly: true;
  deployment: Phase7CRuntimeSourceDeploymentManifest | null;
  overall: Phase7CRuntimeSourceVerdict;
  components: Phase7CRuntimeSourceComponentResult[];
  safety: {
    readOnly: true;
    modeMutation: false;
    armMutation: false;
    autoGate: false;
    lifecycleGate: false;
    orderMutation: false;
    positionMutation: false;
    strategyMutation: false;
    autoRetune: false;
  };
}

export interface Phase7CRuntimeSourceAttestationDeps {
  runtimeRoot: string;
  projectRoot: string;
  apiPid: number;
  now: () => number;
  readUtf8: (file: string) => string;
  sha256File: (file: string) => string;
  isPidAlive: (pid: number) => boolean;
}
```

Stable reason codes used in V1 tests must include at least:

```text
DEPLOYMENT_MATCH
SOURCE_COMMIT_MISMATCH
SOURCE_TREE_MISMATCH
DEPLOYMENT_ID_MISMATCH
CONFIG_FINGERPRINT_MISMATCH
CURRENT_PID_MISSING
PID_MISMATCH
PROCESS_ALIVE
ATTESTED_PID_DEAD
LAUNCHER_HASH_MISMATCH
EVIDENCE_MISSING
EVIDENCE_INVALID
```

---

### Task 1: Core identity, fingerprint, manifest and verdict primitives

**Files:**
- Create: `scripts/lib/phase7c-runtime-source-attestation.ps1`
- Create: `apps/api/src/services/phase7c-runtime-source-attestation.service.ts`
- Create: `apps/api/src/services/phase7c-runtime-source-attestation.service.test.ts`
- Create: `scripts/test-phase7c-runtime-source-attestation-source.ps1`

**Interfaces:**

PowerShell functions:

```text
Get-Phase7CRuntimeSourceConfigIdentity([string] RuntimeRoot, [string] AccountMode, [bool] LiveExecutionEnabled, [string] ControlApiUrl)
Get-Phase7CRuntimeSourceConfigFingerprint([object] ConfigIdentity) -> string
Initialize-Phase7CRuntimeSourceDeployment([string] RuntimeRoot, [string] SourceCommit, [string] SourceTree, [string] Branch, [object] ConfigIdentity) -> PSCustomObject
Read-Phase7CRuntimeSourceDeployment([string] RuntimeRoot) -> PSCustomObject
Write-Phase7CRuntimeSourceComponentAttestation([string] RuntimeRoot, [string] Component, [int] ProcessId, [string] LauncherPath, [object] ConfigIdentity) -> PSCustomObject
```

TypeScript functions:

```ts
export function canonicalizePhase7CRuntimeSourceConfig(input: Phase7CRuntimeSourceConfigIdentity): string;
export function fingerprintPhase7CRuntimeSourceConfig(input: Phase7CRuntimeSourceConfigIdentity): string;
export function evaluatePhase7CRuntimeSourceComponent(input: Phase7CRuntimeSourceComponentEvaluationInput): Phase7CRuntimeSourceComponentResult;
export function combinePhase7CRuntimeSourceVerdicts(values: readonly Phase7CRuntimeSourceVerdict[]): Phase7CRuntimeSourceVerdict;
```

- [ ] **Step 1: Write Node RED tests for canonical fingerprint and precedence**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  combinePhase7CRuntimeSourceVerdicts,
  fingerprintPhase7CRuntimeSourceConfig,
} from "./phase7c-runtime-source-attestation.service";

const fixture = {
  version: 1 as const,
  accountMode: "LIVE" as const,
  liveExecutionEnabled: true,
  runtimeRoot: "F:\\Project\\XAUUSD_AI_MASTER\\xauusd-ai-master\\.runtime",
  controlApiUrl: "http://127.0.0.1:3711",
};

test("fingerprint fixture is cross-language stable", () => {
  assert.equal(
    fingerprintPhase7CRuntimeSourceConfig(fixture),
    "sha256:ad7ecee6a3c038992ba8816bf8ec8235bc2febbdad35fcd07a35c511512445d9",
  );
});

test("overall precedence is mismatch then unknown then stale then exact", () => {
  assert.equal(combinePhase7CRuntimeSourceVerdicts(["EXACT_MATCH", "STALE"]), "STALE");
  assert.equal(combinePhase7CRuntimeSourceVerdicts(["STALE", "UNKNOWN"]), "UNKNOWN");
  assert.equal(combinePhase7CRuntimeSourceVerdicts(["UNKNOWN", "MISMATCH"]), "MISMATCH");
});
```

- [ ] **Step 2: Run Node test and prove RED**

```bash
pnpm --filter @xauusd/api exec node --import tsx --test src/services/phase7c-runtime-source-attestation.service.test.ts
```

Expected: FAIL because the new service exports do not exist.

- [ ] **Step 3: Write PowerShell RED contract**

The functional part uses a temporary directory only:

```powershell
$Helper = Join-Path $ProjectRoot "scripts\lib\phase7c-runtime-source-attestation.ps1"
if (-not (Test-Path -LiteralPath $Helper)) {
  throw "RED: runtime source attestation helper missing: $Helper"
}
. $Helper

$identity = Get-Phase7CRuntimeSourceConfigIdentity `
  -RuntimeRoot "F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master\.runtime" `
  -AccountMode LIVE `
  -LiveExecutionEnabled $true `
  -ControlApiUrl "http://127.0.0.1:3711"
$fingerprint = Get-Phase7CRuntimeSourceConfigFingerprint -ConfigIdentity $identity
if ($fingerprint -ne "sha256:ad7ecee6a3c038992ba8816bf8ec8235bc2febbdad35fcd07a35c511512445d9") {
  throw "Cross-language fingerprint mismatch: $fingerprint"
}
```

- [ ] **Step 4: Run PS7 and Windows PowerShell 5.1 and prove RED**

```powershell
pwsh -NoProfile -File .\scripts\test-phase7c-runtime-source-attestation-source.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-phase7c-runtime-source-attestation-source.ps1
```

Expected: both FAIL at the explicit missing-helper RED marker.

- [ ] **Step 5: Implement canonicalization and atomic JSON in PowerShell**

Build `[ordered]` fields exactly in this order:

```powershell
[ordered]@{
  version = 1
  accountMode = $AccountMode.Trim().ToUpperInvariant()
  liveExecutionEnabled = [bool]$LiveExecutionEnabled
  runtimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
  controlApiUrl = $ControlApiUrl.TrimEnd('/')
}
```

Canonical UTF-8 text must match compact `JSON.stringify` semantics. SHA-256 returns prefix `sha256:` plus 64 lowercase hex characters. Atomic writes: sibling temp file, UTF-8 no BOM, flush/close, atomic replace when target exists or move when absent, temp cleanup in `finally`.

- [ ] **Step 6: Implement deployment idempotency and component writer**

Manifest tuple is exactly `sourceCommit + sourceTree + branch + worktreeClean(true) + configFingerprint`. Same tuple reuses `deploymentId` and `createdAt`; changed tuple creates a new 32-character lowercase GUID identity and a new Unix-ms `createdAt`.

The component writer reads commit/tree/deployment ID from the manifest but computes `configFingerprint` from the supplied process startup `ConfigIdentity`, hashes `LauncherPath`, and writes the approved component schema. This is what makes actual launch-config drift visible.

- [ ] **Step 7: Implement TypeScript canonicalization and verdict primitives**

Use `createHash("sha256")`. `evaluatePhase7CRuntimeSourceComponent` returns `MISMATCH` for contradictory valid evidence, `STALE` for a valid old record with dead attested PID and no different live current PID, `UNKNOWN` for absent/unreadable evidence, and `EXACT_MATCH` only when every equality/liveness/hash check passes.

- [ ] **Step 8: Expand tests to the approved matrix**

Cover wrong commit/tree/deployment ID/config fingerprint/launcher hash/component name, live current PID vs attested PID, dead historical PID, missing/malformed manifest, missing/malformed component, all exact, and overall precedence.

- [ ] **Step 9: Run Task 1 GREEN**

Run Step 2 plus both Step 4 commands. Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add scripts/lib/phase7c-runtime-source-attestation.ps1 scripts/test-phase7c-runtime-source-attestation-source.ps1 apps/api/src/services/phase7c-runtime-source-attestation.service.ts apps/api/src/services/phase7c-runtime-source-attestation.service.test.ts
git commit -m "feat: add runtime source attestation primitives"
```

---

### Task 2: Canonical deployment manifest creation/reuse

**Files:**
- Modify: `scripts/recover-phase7c-runtime-ready-stable-deploy-local.ps1` after the existing branch/clean/exact-commit guard.
- Modify: `scripts/deploy-phase7c-web-ui-local.ps1` after the existing branch/clean/exact-commit guard and before broker freshness/build/restart.
- Modify: `scripts/test-phase7c-runtime-source-attestation-source.ps1`
- Modify: `scripts/test-phase7c-runtime-ready-stable-recovery-deploy-source.ps1`
- Modify: `scripts/test-phase7c-web-ui-safe-deploy-source.ps1`

**Interfaces:** Consumes `Initialize-Phase7CRuntimeSourceDeployment`; produces `.runtime/phase7c-source-attestation/deployment.json` before any P1-aware process starts.

- [ ] **Step 1: Add RED ordering assertions**

Require both guarded paths to load `scripts/lib/phase7c-runtime-source-attestation.ps1`, resolve tree from the already-proven exact commit, and initialize the manifest only after source guard success. Web initialization precedes API/Web restart; recovery initialization precedes every branch that may repair/restart task or lifecycle.

- [ ] **Step 2: Prove RED in PS7 + PS5.1**

Run P1, stable-recovery, and safe-deploy source tests in both engines. Expected: only new attestation assertions fail.

- [ ] **Step 3: Resolve exact source tree after commit equality**

```powershell
$sourceTree = ([string](& $gitExe rev-parse "$ExpectedCommit`^{tree}")).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $sourceTree -notmatch '^[0-9a-f]{40}$') {
  throw "Could not resolve exact source tree for runtime attestation."
}
```

- [ ] **Step 4: Build the deployment config identity from canonical state**

For both scripts, resolve runtime root and read the canonical `phase7c-account-mode.json` beneath it. Validate `version=1`, `accountMode` in `DEMO|LIVE`, and LIVE/DEMO `liveExecutionEnabled` consistency. Use the exact local Control API URL already used by the script. Do not read or hash raw bridge/Telegram env contents.

Initialize and print:

```powershell
Write-Host "PHASE7C_RUNTIME_SOURCE_DEPLOYMENT_ID=$($deployment.deploymentId)"
Write-Host "PHASE7C_RUNTIME_SOURCE_COMMIT=$($deployment.sourceCommit)"
Write-Host "PHASE7C_RUNTIME_SOURCE_TREE=$($deployment.sourceTree)"
Write-Host "PHASE7C_RUNTIME_SOURCE_MANIFEST=READY"
```

- [ ] **Step 5: Test same-identity reuse and changed-identity rotation**

The temp contract initializes the same tuple twice and requires same `deploymentId`/`createdAt`. Then sleep at least 5 ms, change source tree or account mode, and require a different `deploymentId` with `createdAt` greater than the earlier generation.

- [ ] **Step 6: Run all touched source contracts GREEN in both PowerShell engines**

Existing recovery ordering, battery repair, broker freshness, PAUSE/DISARM assertions remain unchanged and pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/recover-phase7c-runtime-ready-stable-deploy-local.ps1 scripts/deploy-phase7c-web-ui-local.ps1 scripts/test-phase7c-runtime-source-attestation-source.ps1 scripts/test-phase7c-runtime-ready-stable-recovery-deploy-source.ps1 scripts/test-phase7c-web-ui-safe-deploy-source.ps1
git commit -m "feat: stamp canonical runtime deployment identity"
```

---

### Task 3: Broker, supervisor and executor child attestations

**Files:**
- Modify: `scripts/run-phase7c-executor-task-runner-local.ps1`
- Modify: `scripts/run-phase7c-executors-local.ps1`
- Modify: `scripts/test-phase7c-runtime-source-attestation-source.ps1`
- Modify: `scripts/test-phase7c-system-lifecycle-broker-source.ps1`

**Interfaces:** Produces component records for `lifecycle-broker`, `supervisor`, `trend`, `sideway`, `telegram`, `regime-notifier` using the Task 1 writer.

- [ ] **Step 1: Add RED canonical-PID and launcher assertions**

Lock PID sources:

```text
lifecycle-broker = task-runner $PID
supervisor = same $PID written to supervisor.pid
trend = same Start-Process Id written to trend.pid
sideway = same Start-Process Id written to sideway.pid
telegram = same Start-Process Id written to telegram-mode.pid
regime-notifier = same Start-Process Id written to regime-notifier.pid
```

Lock launcher files to their six existing scripts.

- [ ] **Step 2: Prove RED**

Run P1 source contract under PS7/PS5.1 and existing lifecycle-broker source contract. Expected: P1 writer calls missing.

- [ ] **Step 3: Add best-effort lifecycle-broker attestation**

After boot config/runtime root are resolved and startup lock is acquired, create `ConfigIdentity` from `$bootConfig.accountMode`, `$bootConfig.liveExecutionEnabled`, `$workDir`, `$controlApiUrl`, then call writer with `$PID` and `$PSCommandPath` inside `try/catch`. On failure log warning and continue broker startup.

- [ ] **Step 4: Add best-effort supervisor and child attestation wrapper**

Create one supervisor `ConfigIdentity` from current `AccountMode`, `LiveExecutionEnabled`, resolved `WorkDir`, `ControlApiUrl`. After each existing PID file is written, call the writer with that exact PID and direct launcher path. Do not change child command lines or trading parameters.

- [ ] **Step 5: Scope no-mutation source assertions correctly**

Do not globally forbid existing safety mutations in lifecycle/recovery scripts. The existing broker/recovery code legitimately contains PAUSE/stop/recovery operations. Instead:

- assert the new shared P1 helper itself contains no mode/ARM/task/order/process-control mutation;
- assert each new attestation call is inside best-effort `try/catch` and only writes attestation/log output;
- leave existing broker/recovery safety tests responsible for pre-existing lifecycle behavior.

- [ ] **Step 6: Run P1 + broker source/protocol contracts GREEN**

- [ ] **Step 7: Commit**

```bash
git add scripts/run-phase7c-executor-task-runner-local.ps1 scripts/run-phase7c-executors-local.ps1 scripts/test-phase7c-runtime-source-attestation-source.ps1 scripts/test-phase7c-system-lifecycle-broker-source.ps1
git commit -m "feat: attest Phase7C executor runtime processes"
```

---

### Task 4: API self-attestation, aggregation and GET-only route

**Files:**
- Modify: `scripts/run-phase7b-api-runtime-local.ps1`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/services/phase7c-runtime-source-attestation.service.ts`
- Modify: `apps/api/src/services/phase7c-runtime-source-attestation.service.test.ts`
- Modify: `apps/api/src/routes/phase7c.route.ts`
- Modify: `scripts/test-phase7c-runtime-source-attestation-source.ps1`

**Interfaces:**

```ts
export function writePhase7CApiRuntimeSourceAttestation(): Phase7CRuntimeSourceComponentAttestation;
export function getPhase7CRuntimeSourceAttestationSnapshot(deps?: Partial<Phase7CRuntimeSourceAttestationDeps>): Phase7CRuntimeSourceAttestationSnapshot;
```

Route: `GET /api/v1/phase7c/runtime-source-attestation`.

- [ ] **Step 1: Add Node RED tests for complete snapshot**

Build temp fixtures and inject liveness/hash/read functions. All-exact fixture asserts seven components, `overall === "EXACT_MATCH"`, `readOnly === true`, and every safety mutation/gate flag false.

- [ ] **Step 2: Prove RED**

Run Task 1 Node command. Expected: snapshot/API-writer exports missing.

- [ ] **Step 3: Pass non-secret actual API startup context from PowerShell**

After canonical account-mode state is validated and before `pnpm ... start`, set:

```powershell
$env:PHASE7C_SOURCE_ATTESTATION_ROOT = Join-Path $WorkDir "phase7c-source-attestation"
$env:PHASE7C_SOURCE_ATTESTATION_API_LAUNCHER = $PSCommandPath
$env:PHASE7C_SOURCE_ATTESTATION_ACCOUNT_MODE = $accountMode
$env:PHASE7C_SOURCE_ATTESTATION_LIVE_EXECUTION_ENABLED = if ($liveExecutionEnabled) { "true" } else { "false" }
$env:PHASE7C_SOURCE_ATTESTATION_CONTROL_API_URL = "http://127.0.0.1:$ApiPort"
```

No secret value is added.

- [ ] **Step 4: Write API record from actual Node PID and actual startup config**

Inside successful `app.listen` callback, call `writePhase7CApiRuntimeSourceAttestation()` in `try/catch`. The service reads deployment commit/tree/ID from manifest, builds current `Phase7CRuntimeSourceConfigIdentity` from the non-secret env values, computes its own fingerprint, hashes the API launcher path, and writes `pid: process.pid`. Failure logs `...=UNKNOWN` and does not stop API.

- [ ] **Step 5: Implement current-PID + launcher mapping**

```text
api -> process.pid -> scripts/run-phase7b-api-runtime-local.ps1
lifecycle-broker -> heartbeat/status agreeing brokerPid -> scripts/run-phase7c-executor-task-runner-local.ps1
supervisor -> supervisor.pid -> scripts/run-phase7c-executors-local.ps1
trend -> trend.pid -> scripts/run-phase7c-trend-controller-local.ps1
sideway -> sideway.pid -> scripts/run-phase7c-sideway-controller-local.ps1
telegram -> telegram-mode.pid -> scripts/run-phase7c-telegram-mode-controller-local.ps1
regime-notifier -> regime-notifier.pid -> scripts/run-phase7c-regime-notifier-local.ps1
```

Only read/hash/liveness operations are allowed. Liveness may probe with signal `0`; no process-control signal.

- [ ] **Step 6: Implement localhost GET route**

```ts
router.get("/runtime-source-attestation", (req, res) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Runtime source attestation is restricted to localhost." });
    return;
  }
  res.setHeader("cache-control", "no-store");
  res.json(getPhase7CRuntimeSourceAttestationSnapshot());
});
```

No POST/PUT/PATCH/DELETE attestation route exists.

- [ ] **Step 7: Add scoped no-mutation/no-Git source assertions**

For the new TypeScript P1 service/route and the new Web card only, reject `phase7CBotModeService.set`, ARM execution, lifecycle action invocation, order mutation, `child_process`, `exec`, `spawn`, and Git subprocess calls. Do not scan the entire existing recovery script for these tokens because it legitimately contains pre-existing safety actions.

- [ ] **Step 8: Run Node tests + API build + PS contracts GREEN**

```bash
pnpm --filter @xauusd/api exec node --import tsx --test src/services/phase7c-runtime-source-attestation.service.test.ts
pnpm --filter @xauusd/api build
```

plus both P1 PowerShell source-contract runs.

- [ ] **Step 9: Commit**

```bash
git add scripts/run-phase7b-api-runtime-local.ps1 apps/api/src/index.ts apps/api/src/services/phase7c-runtime-source-attestation.service.ts apps/api/src/services/phase7c-runtime-source-attestation.service.test.ts apps/api/src/routes/phase7c.route.ts scripts/test-phase7c-runtime-source-attestation-source.ps1
git commit -m "feat: expose read-only runtime source attestation"
```

---

### Task 5: Read-only Control Center card

**Files:**
- Modify: `apps/web/src/phase7c-types.ts`
- Modify: `apps/web/src/api.ts`
- Create: `apps/web/src/ui/Phase7CRuntimeSourceAttestationCard.tsx`
- Modify: `apps/web/src/pages/Phase7CControlCenterShellPage.tsx`
- Modify: `scripts/test-phase7c-runtime-source-attestation-source.ps1`

**Interfaces:**

```ts
export async function getPhase7CRuntimeSourceAttestation(): Promise<Phase7CRuntimeSourceAttestationSnapshot>;
```

TanStack query key: `phase7c-runtime-source-attestation`.

- [ ] **Step 1: Add RED UI source assertions**

Require type/getter/card/shell integration and exact warning copy `READ-ONLY WARNING — NO AUTOMATIC ACTION TAKEN`. Reject `useMutation` and AUTO/ARM/lifecycle mutation imports/calls in the new card.

- [ ] **Step 2: Prove RED under PS7 + PS5.1**

- [ ] **Step 3: Add Web response types and GET client**

Mirror the locked API snapshot contract in `phase7c-types.ts` and implement:

```ts
export async function getPhase7CRuntimeSourceAttestation(): Promise<Phase7CRuntimeSourceAttestationSnapshot> {
  return read<Phase7CRuntimeSourceAttestationSnapshot>(
    await fetch(`${API_BASE}/api/v1/phase7c/runtime-source-attestation`, { cache: "no-store" }),
  );
}
```

- [ ] **Step 4: Implement query-only card**

Use `useQuery`, 5-second refresh, `retry: false`. Render accepted commit, deployment ID, overall verdict and seven component rows. Visual mapping: exact=success, mismatch=error, stale=warning, unknown=warning/default. Non-exact overall shows the exact warning. No button/switch/action.

- [ ] **Step 5: Mount card between authorization and existing control content**

```tsx
<Phase7CExecutionAuthorizationCard />
<Phase7CRuntimeSourceAttestationCard />
<Phase7CControlCenterPage />
```

- [ ] **Step 6: Run Web build + P1 source contract GREEN**

```bash
pnpm --filter @xauusd/web build
```

and both PowerShell engines.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/phase7c-types.ts apps/web/src/api.ts apps/web/src/ui/Phase7CRuntimeSourceAttestationCard.tsx apps/web/src/pages/Phase7CControlCenterShellPage.tsx scripts/test-phase7c-runtime-source-attestation-source.ps1
git commit -m "feat: show runtime source attestation in Control Center"
```

---

### Task 6: CI coverage and touched-path regression lock

**Files:**
- Modify: `.github/workflows/phase7c-canonical-pr-gate.yml`
- Modify: `.github/workflows/phase7c-runtime-ready-stable-recovery-deploy-ci.yml`
- Modify: `scripts/test-phase7c-runtime-source-attestation-source.ps1`

**Interfaces:** CI exercises Node behavior tests, PS7, PS5.1, API/Web builds, and existing lifecycle/recovery/deploy safety contracts.

- [ ] **Step 1: Add RED workflow assertions**

Require both workflows to reference `test-phase7c-runtime-source-attestation-source.ps1`; recovery workflow path filters include the new helper and every P1-modified launch/deploy file.

- [ ] **Step 2: Prove RED under both PowerShell engines**

- [ ] **Step 3: Extend Canonical PR Gate**

Add Linux behavior test:

```yaml
- name: Runtime source attestation service contract
  run: pnpm --filter @xauusd/api exec node --import tsx --test src/services/phase7c-runtime-source-attestation.service.test.ts
```

Add Windows P1 source-contract steps for `pwsh` and `powershell`. Keep `permissions: contents: read`.

- [ ] **Step 4: Extend Runtime Ready Stable Recovery Deploy CI**

Add P1 paths to PR/main path filters and run P1 source contract in both PowerShell engines. Do not remove/relax existing battery/recovery/safety steps.

- [ ] **Step 5: Run final verification matrix**

Cross-platform:

```bash
pnpm --filter @xauusd/api exec node --import tsx --test src/services/phase7c-runtime-source-attestation.service.test.ts
pnpm --filter @xauusd/api build
pnpm --filter @xauusd/web build
node --test scripts/test-phase7c-canonical-pr-gate-contract.mjs
git diff --check
```

Windows:

```powershell
pwsh -NoProfile -File .\scripts\test-phase7c-runtime-source-attestation-source.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-phase7c-runtime-source-attestation-source.ps1
pwsh -NoProfile -File .\scripts\test-phase7c-system-lifecycle-broker-source.ps1
pwsh -NoProfile -File .\scripts\test-phase7c-system-lifecycle-broker-contract.ps1
pwsh -NoProfile -File .\scripts\test-phase7c-web-ui-safe-deploy-source.ps1
pwsh -NoProfile -File .\scripts\test-phase7c-runtime-ready-stable-recovery-deploy-source.ps1
pwsh -NoProfile -File .\scripts\test-phase7c-web-live-arm-demo-auto-source.ps1
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/phase7c-canonical-pr-gate.yml .github/workflows/phase7c-runtime-ready-stable-recovery-deploy-ci.yml scripts/test-phase7c-runtime-source-attestation-source.ps1
git commit -m "ci: gate runtime source attestation"
```

---

### Task 7: Exact-head review, PR, merge and source production acceptance

**Files:** Review all P1 files, approved spec and this plan. No new production file.

- [ ] **Step 1: Verify provenance and clean diff**

```bash
git merge-base --is-ancestor 4f156ef1b019ef676cc23ed978c9487eb41f2fe6 HEAD
git status --porcelain
git diff --check
git log --oneline --decorate -n 12
```

Expected: accepted P1 base is an ancestor, worktree clean, diff hygiene passes.

- [ ] **Step 2: Re-run Task 6 complete verification on the exact final head**

Earlier GREEN output is not reused as final evidence.

- [ ] **Step 3: Diff-scope review**

Reject changes to strategy entry/management/exit logic, AUTO/ARM policy, order routes, recovery sizing, lot/TP rules, or MT5 trading behavior.

- [ ] **Step 4: Open non-draft PR against current `main`**

Record exact RED/GREEN evidence and:

```text
P1_V1=READ_ONLY
AUTO_GATE=NONE
ARM_GATE=NONE
START_GATE=NONE
ORDER_MUTATION=NONE
AUTO_RETUNE=NONE
LIVE_DEPLOYMENT_IN_PR=NONE
```

- [ ] **Step 5: Require fresh PR CI on exact PR head**

At minimum Canonical PR Gate and Runtime Ready Stable Recovery Deploy CI are `SUCCESS`. Any head change invalidates prior CI evidence.

- [ ] **Step 6: Merge only the exact tested head**

Squash merge with expected head SHA, capture merged `main` SHA, and require main-push CI success on that exact SHA.

- [ ] **Step 7: Record source-only completion**

```text
P1_SOURCE_PRODUCTION_ACCEPTED=TRUE
P1_RUNTIME_LIVE_PROVEN=FALSE
LIVE_RUNTIME_MUTATION=NONE
```

Old LIVE processes cannot retroactively acquire P1 attestations.

---

### Task 8: Guarded LIVE rollout and post-deploy proof — separate operator approval required

**Files:** No source edits. Use existing canonical source-sync/read-only-preflight/recovery/deploy procedures after Task 7.

- [ ] **Step 1: Stop before runtime mutation and obtain explicit operator approval**

Present exact merged-main SHA, main-push CI and current LIVE state. Do not PAUSE, DISARM, restart or deploy before approval.

- [ ] **Step 2: Guarded fast-forward source sync**

Resolve actual merged `main` SHA from GitHub, require local `main`, clean worktree and fast-forward ancestry. No destructive reset/clean.

- [ ] **Step 3: Fresh read-only LIVE preflight**

Require account/runtime/task/broker/lifecycle/positions/orders to classify a supported canonical deployment route. Mixed/blocked state stops rollout.

- [ ] **Step 4: Run existing canonical controlled deployment once**

Use actual merged SHA as `ExpectedCommit`. Existing recovery policy finishes `PAUSE + DISARMED + flat` before any later ARM/AUTO action.

- [ ] **Step 5: Query P1 before ARM/AUTO**

```powershell
$attestation = Invoke-RestMethod -Uri "http://127.0.0.1:3711/api/v1/phase7c/runtime-source-attestation" -Method Get
$attestation.overall
$attestation.components | Format-Table component, verdict, pid, alive, sourceCommit
```

Require `overall=EXACT_MATCH`, all seven required components `EXACT_MATCH`, `readOnly=true`, task drift zero, broker heartbeat fresh, startup lock HELD, lifecycle READY and XAUUSD flat.

- [ ] **Step 6: Record LIVE proof; ARM/AUTO remains separate explicit operator flow**

```text
P1_RUNTIME_LIVE_PROVEN=TRUE
POST_DEPLOY_RUNTIME_ATTESTATION=EXACT_MATCH
P1_MODE_MUTATION=NONE
P1_ARM_MUTATION=NONE
P1_ORDER_MUTATION=NONE
P1_AUTO_RETUNE=NONE
```

---

## Self-Review Coverage Map

- Manifest + same-identity `deploymentId` reuse: Tasks 1-2.
- Cross-language deterministic non-secret fingerprint: Task 1 exact digest fixture.
- Component actual startup config vs manifest fingerprint: Tasks 1, 3, 4.
- Atomic writes: Task 1.
- Seven required components + canonical PID/launcher hashes: Tasks 3-4.
- API attestation from real Node PID: Task 4.
- Verdict matrix + precedence: Tasks 1 and 4.
- GET-only/localhost/no Git/no P1 mutation: Tasks 4 and 6.
- Read-only Control Center warning/no actions: Task 5.
- PS7 + PS5.1 + API/Web build + existing safety regressions: Task 6.
- Fresh PR exact-head + main-push CI: Task 7.
- Post-deploy runtime `EXACT_MATCH`: Task 8.
- P2/P3/P4/P5 remain outside this plan.
