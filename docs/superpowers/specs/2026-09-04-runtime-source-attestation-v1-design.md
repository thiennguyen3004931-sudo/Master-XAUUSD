# P1 Runtime Source Attestation V1 — Design

Date: 2026-09-04
Status: Design approved in chat; written spec pending user review
Base: `main@4f156ef1b019ef676cc23ed978c9487eb41f2fe6`
Scope: P1 only
Safety mode: READ-ONLY V1

## 1. Purpose

P1 Runtime Source Attestation V1 answers one operational question with machine-readable evidence:

> Are the Phase7C runtime processes that are currently alive running from the exact production-accepted deployment identity that the operator expects?

The current system already proves important source/deploy properties before restart: canonical deploy requires branch `main`, a clean working tree, and exact `ExpectedCommit`; lifecycle scripts also prove process liveness through PID files. Those proofs are strong but remain distributed across deploy logs and runtime PID state. They do not provide a single read-only runtime view that binds each live component to one immutable deployment identity.

P1 V1 adds that missing provenance layer without changing trading behavior.

## 2. Non-goals

P1 V1 MUST NOT:

- change bot mode;
- change ARM state;
- block or enable AUTO;
- block or enable lifecycle START;
- stop, restart, or kill any runtime process;
- mutate an MT5 order or position;
- change strategy configuration;
- auto-retune any strategy;
- evaluate trading rule performance;
- implement Decision → Trade → Outcome lineage;
- implement counterfactual/shadow trading;
- make recommendations that affect LIVE behavior.

P2, P3, P4, and P5 are separate later sub-projects.

## 3. Safety contract

P1 V1 is observability-only.

Required contract:

```text
P1_V1=READ_ONLY
AUTO_GATE=NONE
ARM_GATE=NONE
START_GATE=NONE
MODE_MUTATION=NONE
ARM_MUTATION=NONE
ORDER_MUTATION=NONE
POSITION_MUTATION=NONE
STRATEGY_MUTATION=NONE
AUTO_RETUNE=NONE
```

A mismatch is reported, never repaired automatically.

## 4. Architecture

P1 V1 has four bounded parts:

1. **Deployment identity manifest** — immutable identity for one canonical runtime generation.
2. **Per-component process attestation** — one small record emitted at each component startup.
3. **Read-only attestation aggregator** — API service that validates records against current runtime PIDs and the deployment manifest.
4. **Read-only Control Center presentation** — component-by-component status and an overall verdict.

No new daemon is introduced. Existing canonical launch points remain authoritative.

## 5. Deployment identity manifest

### 5.1 Location

Canonical runtime location:

```text
.runtime/phase7c-source-attestation/deployment.json
```

The manifest belongs to the runtime generation, not to an individual process.

### 5.2 Schema

```json
{
  "version": 1,
  "deploymentId": "<opaque generation id>",
  "sourceCommit": "<40-char git SHA>",
  "sourceTree": "<40-char git tree SHA>",
  "branch": "main",
  "worktreeClean": true,
  "createdAt": 0,
  "configFingerprint": "sha256:<64 hex>"
}
```

### 5.3 Creation semantics

The manifest MUST be created only from a canonical source/deploy path that has already proven:

- branch is `main`;
- worktree is clean;
- `HEAD == ExpectedCommit`;
- the source tree SHA is resolved from that exact commit.

The manifest captures identity at deployment/start time. Runtime read APIs MUST NOT use a live `git rev-parse HEAD` call as a substitute for process provenance, because the worktree may change after a process started.

### 5.4 Generation identity and idempotency

`deploymentId` identifies one effective runtime generation. The canonical manifest writer computes the prospective identity tuple:

```text
sourceCommit
sourceTree
branch
worktreeClean=true
configFingerprint
```

Generation rules are deterministic:

1. If a valid existing manifest has the exact same identity tuple, the writer MUST reuse its existing `deploymentId` and `createdAt`.
2. If the identity tuple changes, the writer MUST create a new `deploymentId` and `createdAt` and atomically replace the manifest.
3. A same-source/same-config Web/API restart MUST NOT rotate `deploymentId`; otherwise healthy executor processes would be reported as mismatched solely because the API was restarted.
4. A source, tree, or effective config change intentionally rotates the generation. Any still-running process from the previous generation then remains visibly non-exact until it is restarted through the canonical flow.

This makes generation identity stable across harmless same-identity restarts while still detecting partial deployment of a new source/config generation.

### 5.5 Manifest writer boundary

A small shared canonical helper owns manifest creation/reuse. Existing guarded deploy/recovery/start paths call that helper only after their Git/config preconditions pass and before starting processes that need the identity.

P1 MUST NOT introduce an independent deployment mechanism.

### 5.6 Atomicity

The deployment manifest MUST be written atomically: write a temporary sibling file, flush/close it, then replace/rename into the canonical path. A partially written JSON file is never accepted as valid evidence.

## 6. Non-secret config fingerprint

### 6.1 Purpose

`configFingerprint` distinguishes "same source commit, different effective runtime configuration" without exposing credentials.

### 6.2 Allowed inputs

The fingerprint is derived from one canonical normalized non-secret object. It may include values that materially define the runtime generation, for example:

- account mode (`DEMO` / `LIVE`);
- live-execution-enabled boolean;
- canonical work directory identity;
- control API host/port identity;
- Trend fixed lot;
- Sideway risk percent;
- Sideway max lot;
- Fixed TP enable flags and distances;
- canonical strategy-entry configuration version/hash where already non-secret;
- relevant feature/config version numbers.

### 6.3 Forbidden inputs

The fingerprint input material MUST NOT contain or serialize:

- `MT5_API_KEY`;
- Telegram bot token;
- passwords;
- login secrets;
- authentication tokens;
- any raw environment file contents;
- any secret that would allow replay or account access.

Account login/server identity SHOULD NOT be placed in the attestation payload unless an existing public runtime view already exposes it and the implementation requires it. P1 does not need those fields to prove source identity.

The implementation MUST define one canonical normalization function and hash exactly that normalized object with SHA-256. Equivalent normalized configuration MUST yield the same fingerprint across PowerShell 7, Windows PowerShell 5.1, and Node readers.

## 7. Component attestations

### 7.1 Directory

```text
.runtime/phase7c-source-attestation/components/
```

### 7.2 Required components

V1 covers these runtime components:

```text
api
lifecycle-broker
supervisor
trend
sideway
telegram
regime-notifier
```

Trade notifier is intentionally out of the required V1 overall verdict because the current lifecycle READY contract is centered on supervisor/trend/sideway/telegram/regime-notifier plus the lifecycle broker and API. It may be added later without changing the V1 verdict model.

### 7.3 Record schema

Each component record contains:

```json
{
  "version": 1,
  "component": "trend",
  "deploymentId": "<same deployment id>",
  "sourceCommit": "<same exact commit>",
  "sourceTree": "<same exact tree>",
  "pid": 12345,
  "startedAt": 0,
  "launcherSha256": "<64 hex>",
  "configFingerprint": "sha256:<64 hex>"
}
```

### 7.4 Startup semantics

A component record MUST be emitted at startup from inherited immutable deployment identity, not by discovering a potentially changed Git worktree later.

Expected propagation:

```text
canonical deploy/recovery/start
  -> deployment manifest
  -> lifecycle broker / API launch environment
  -> supervisor launch environment
  -> trend / sideway / telegram / regime-notifier children
```

The lifecycle broker runner is the canonical SYSTEM launch boundary for executor lifecycle. The supervisor remains the canonical child process launcher. P1 extends those existing boundaries rather than introducing a parallel process-control mechanism.

A component may write its own attestation, or the canonical launcher that has just created it may write the record on its behalf, provided the record contains the actual canonical runtime PID of the represented component and inherited immutable identity. The launcher MUST NOT use its own PID as the represented child PID.

### 7.5 Canonical PID identity

P1 binds to the same process identity the existing runtime treats as canonical:

- `api`: the running API process verifies its attestation PID against `process.pid`;
- `lifecycle-broker`: broker PID comes from canonical broker heartbeat/status;
- `supervisor`: existing `supervisor.pid`;
- `trend`: existing `trend.pid`;
- `sideway`: existing `sideway.pid`;
- `telegram`: existing `telegram-mode.pid`;
- `regime-notifier`: existing `regime-notifier.pid`.

If a PowerShell wrapper is the PID currently used by lifecycle health, that wrapper PID is the P1 canonical PID. P1 does not silently switch to an internal Node child PID unless the lifecycle contract is separately redesigned.

### 7.6 Launcher hash

`launcherSha256` hashes the canonical startup artifact directly responsible for that component's canonical runtime process. This provides secondary evidence that the component was launched through the expected source artifact.

The aggregator compares the recorded hash with the expected launcher artifact from the accepted deployment source. A changed launcher artifact after process start is therefore visible instead of being silently treated as exact.

Launcher hash mismatch is a `MISMATCH` condition, not merely informational.

### 7.7 Atomicity and overwrite

Every component attestation MUST be written atomically.

Starting a new process generation overwrites the canonical component record for that component. The aggregator distinguishes old/stale records by PID and deployment identity rather than relying on file timestamps alone.

## 8. Aggregator service

### 8.1 Endpoint

Add a GET-only endpoint:

```text
GET /api/v1/phase7c/runtime-source-attestation
```

The endpoint is read-only and uses `cache-control: no-store`.

For V1 it follows the localhost-oriented operational model used by lifecycle runtime diagnostics. It MUST NOT expose a mutation method under the same route.

### 8.2 Data sources

The aggregator reads:

- `deployment.json`;
- component attestation JSON files;
- canonical PID/lifecycle evidence described in section 7.5;
- current process liveness;
- current canonical launcher files only for hash comparison.

It does not execute Git commands during ordinary GET handling.

### 8.3 Component verdicts

Each component receives exactly one verdict:

- `EXACT_MATCH`
- `MISMATCH`
- `STALE`
- `UNKNOWN`

#### EXACT_MATCH

All of the following MUST hold:

- deployment manifest valid;
- component attestation valid;
- `deploymentId` matches deployment manifest;
- `sourceCommit` matches deployment manifest;
- `sourceTree` matches deployment manifest;
- `configFingerprint` matches deployment manifest;
- attestation PID equals the current canonical runtime PID for that component;
- PID is alive;
- launcher hash matches the current expected launcher artifact.

No missing check may be interpreted as PASS.

#### MISMATCH

Use `MISMATCH` when evidence exists but contradicts the accepted deployment identity, including:

- wrong source commit;
- wrong source tree;
- wrong deployment ID;
- wrong config fingerprint;
- wrong launcher hash;
- a live current PID whose attestation declares another PID;
- component field does not match the file/component being evaluated.

#### STALE

Use `STALE` when a syntactically valid historical attestation remains but no longer represents the current live component, for example:

- attested PID is dead and there is no different current live PID;
- attestation belongs to an older process generation after normal shutdown.

If a different current live PID exists but only an old record is present, report `MISMATCH` because the currently running process is not attested by the record being presented as current evidence.

#### UNKNOWN

Use `UNKNOWN` when evidence is absent or unreadable without positive contradictory evidence, including:

- deployment manifest missing or invalid;
- component attestation missing;
- component attestation malformed;
- current canonical PID cannot be resolved;
- launcher file/hash cannot be read.

Invalid/missing evidence never becomes `EXACT_MATCH`.

## 9. Overall verdict

Overall status is one of:

```text
EXACT_MATCH
MISMATCH
STALE
UNKNOWN
```

Precedence:

1. any required component `MISMATCH` -> overall `MISMATCH`;
2. else any required component `UNKNOWN` -> overall `UNKNOWN`;
3. else any required component `STALE` -> overall `STALE`;
4. else all required components `EXACT_MATCH` -> overall `EXACT_MATCH`.

This precedence favors visible contradictory evidence over absence of evidence.

The overall verdict is observability only in V1.

## 10. API response contract

Representative response:

```json
{
  "version": 1,
  "source": "PHASE7C_RUNTIME_SOURCE_ATTESTATION",
  "generatedAt": 0,
  "readOnly": true,
  "deployment": {
    "deploymentId": "...",
    "sourceCommit": "4f156ef1...",
    "sourceTree": "0ab41605...",
    "branch": "main",
    "worktreeClean": true,
    "configFingerprint": "sha256:..."
  },
  "overall": "EXACT_MATCH",
  "components": [
    {
      "component": "api",
      "verdict": "EXACT_MATCH",
      "pid": 1234,
      "alive": true,
      "sourceCommit": "4f156ef1...",
      "deploymentId": "...",
      "reasonCodes": ["DEPLOYMENT_MATCH", "PID_MATCH", "PROCESS_ALIVE", "LAUNCHER_HASH_MATCH"]
    }
  ],
  "safety": {
    "readOnly": true,
    "modeMutation": false,
    "armMutation": false,
    "autoGate": false,
    "lifecycleGate": false,
    "orderMutation": false,
    "positionMutation": false,
    "strategyMutation": false,
    "autoRetune": false
  }
}
```

Reason codes are stable machine-readable tokens. Human-readable UI text is derived from them.

## 11. Control Center

Add a read-only card named **Runtime Source Attestation**.

It displays:

- accepted deployment commit;
- deployment generation ID (shortened for display);
- overall verdict;
- API;
- lifecycle broker;
- supervisor;
- Trend;
- Sideway;
- Telegram;
- regime notifier.

Suggested visual mapping:

```text
EXACT_MATCH -> success
MISMATCH    -> error
STALE       -> warning
UNKNOWN     -> warning/info
```

When overall status is not `EXACT_MATCH`, the UI MUST explicitly state:

```text
READ-ONLY WARNING — NO AUTOMATIC ACTION TAKEN
```

P1 V1 MUST NOT add an `Apply`, `Repair`, `Restart`, `Pause`, `Disarm`, or `Retune` action to this card.

## 12. Integration with existing source safety

`/api/v1/phase7c/source-safety` remains the static source-safety/performance-attribution contract.

P1 attestation is a separate runtime endpoint because it has different semantics:

- source-safety = declared source contract;
- runtime-source-attestation = evidence about currently running processes.

They may be displayed together in Control Center, but the services remain independently testable.

## 13. Error handling

P1 prefers explicit degraded states to exceptions for normal missing/stale runtime evidence.

Examples:

- missing component record -> `UNKNOWN` component;
- dead old PID -> `STALE` component;
- mismatched live PID -> `MISMATCH` component;
- malformed deployment manifest -> overall `UNKNOWN` with a stable reason code;
- filesystem read error -> `UNKNOWN`, no mutation;
- hash read failure -> `UNKNOWN`, no mutation.

The endpoint may return HTTP 500 only for an unexpected service failure that prevents constructing any valid snapshot. Ordinary provenance gaps are represented in the 200 response.

## 14. Deployment compatibility

The first deployment containing P1 introduces a bootstrap concern: old processes cannot have P1 component attestations until they are restarted through the new canonical deployment path.

Therefore:

- source-only merge/CI does not claim current old runtime is attested;
- after canonical deployment/recovery of the P1 source, each new process must emit its attestation;
- before that restart, P1 may correctly report `UNKNOWN`/`STALE`/`MISMATCH` depending on the evidence present;
- this is not a reason to auto-restart or mutate LIVE.

The deployment procedure remains the existing guarded deploy/recovery workflow. P1 does not invent a new deployment mechanism.

A partial deployment of a new identity is intentionally visible: components already restarted into the new generation can be exact while still-running old-generation components are non-exact, producing an overall non-exact verdict until the canonical deployment completes.

## 15. Test strategy

Implementation follows TDD.

### 15.1 Unit/service tests

Required cases:

```text
all required components exact              -> EXACT_MATCH
one component wrong commit                 -> MISMATCH
one component wrong tree                   -> MISMATCH
deploymentId mismatch                      -> MISMATCH
configFingerprint mismatch                 -> MISMATCH
launcherSha256 mismatch                    -> MISMATCH
live current PID != attested PID           -> MISMATCH
old attested PID dead                      -> STALE
missing component file                     -> UNKNOWN
malformed component file                   -> UNKNOWN
missing deployment manifest                -> UNKNOWN
malformed deployment manifest              -> UNKNOWN
all exact except one UNKNOWN               -> UNKNOWN
all exact except one STALE                 -> STALE
MISMATCH plus UNKNOWN                      -> MISMATCH
same source/tree/config redeploy            -> reuse deploymentId
changed source/tree/config                  -> rotate deploymentId
API attestation PID != process.pid          -> MISMATCH
```

### 15.2 Source/safety contract tests

Tests MUST prove:

```text
GET-only endpoint exists
no POST/PUT/PATCH/DELETE attestation mutation route
AUTO mutation absent
ARM mutation absent
lifecycle mutation absent
order mutation absent
position mutation absent
strategy mutation absent
auto-retune absent
secret fields absent from schemas and fixtures
ordinary GET path executes no Git command
```

### 15.3 Windows launch contract tests

PowerShell source-contract tests must cover generation propagation, canonical PID binding, and atomic write semantics under both:

```text
PowerShell 7
Windows PowerShell 5.1
```

The normalization/fingerprint fixture must produce the same expected SHA-256 under the PowerShell and Node implementations/readers used by the design.

### 15.4 Build/regression gates

At minimum:

- API build;
- Web build;
- canonical Phase7C source/safety regression;
- existing lifecycle/recovery safety regressions relevant to modified launch files;
- no runtime LIVE mutation from CI/tests.

## 16. Expected implementation boundaries

The implementation plan should prefer focused files rather than overloading existing services. Expected boundaries may include:

- a small shared attestation schema/helper for normalization, hashing, atomic write/read;
- launch-script integration at canonical broker/API/supervisor-child boundaries;
- a dedicated API attestation aggregation service;
- one GET route under Phase7C;
- Web types/hook/card;
- dedicated tests/source contracts.

Exact file names are intentionally deferred to the implementation plan after repository-level dependency review.

## 17. Rollout criteria

P1 V1 is complete only when all of the following are proven:

```text
SOURCE_BRANCH_FROM_ACCEPTED_MAIN=TRUE
TDD_RED_PROVEN=TRUE
TDD_GREEN_PROVEN=TRUE
PS7_SOURCE_CONTRACT=PASS
PS51_SOURCE_CONTRACT=PASS
API_BUILD=PASS
WEB_BUILD=PASS
SAFETY_REGRESSION=PASS
PR_FRESH_CI=PASS
MAIN_PUSH_CI=PASS
CANONICAL_DEPLOY_EXACT_SHA=PASS
POST_DEPLOY_RUNTIME_ATTESTATION=EXACT_MATCH
LIVE_MODE_MUTATION_BY_P1=NONE
LIVE_ARM_MUTATION_BY_P1=NONE
LIVE_ORDER_MUTATION_BY_P1=NONE
```

A merged source without post-deploy `EXACT_MATCH` is production-accepted source, but P1 is not yet LIVE-proven until runtime attestation confirms the new process generation.

## 18. Future compatibility with P2–P5

P1 exposes two stable identifiers intended for later reuse:

- `deploymentId`
- `sourceCommit`

P2 may stamp these identifiers into every decision lineage record. P3 may aggregate outcomes by rule-set/source generation. P4 may bind shadow observations to the same source generation. P5 may cite the exact evidence generation behind a recommendation.

P1 itself remains independent of those later analytics systems.

## 19. Final design decision

P1 V1 deliberately chooses observability before enforcement.

A future P1 V2 may propose a guarded hard gate such as "block new AUTO activation when runtime source attestation is not EXACT_MATCH", but that is explicitly outside this design and would require a separate design, TDD cycle, CI, operator approval, and LIVE rollout.
