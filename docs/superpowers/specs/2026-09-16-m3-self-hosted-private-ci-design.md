# M3 Self-Hosted Private CI Design

## 1. Status and purpose

This design refines M3 from the approved Public / Private Repository Split so private CI can execute on `thiennguyen3004931-sudo/xauusd-ai-master-core` without depending on GitHub-hosted runner minutes.

At design inception, private GitHub Actions runs were being created but jobs terminated before any step executed (`steps=[]`). The implemented solution adds one repository-level Windows self-hosted runner and one canonical private Master/Core workflow. Exact-head runtime evidence now proves that the runner executes the full M3 gate successfully.

This remains source/CI infrastructure only. It does not authorize production rollout or trading-runtime mutation.

## 2. Relationship to the existing repository-split plan

The existing split plan defines M3 responsibilities including:

- `scripts/security/check-private-secrets.mjs`;
- `scripts/security/check-private-secrets.test.mjs`;
- `.github/workflows/private-master-core-ci.yml`;
- private bootstrap provenance verification;
- tracked-secret verification;
- build and regression verification.

This design does not replace or weaken those requirements. It adds the runner architecture and exact-head verification required to execute them without GitHub-hosted runner minutes.

Two status levels remain distinct:

```text
SELF_HOSTED_CI_INFRA=PASS
```

means the private workflow is assigned to the self-hosted runner and real steps execute successfully.

```text
M3_PRIVATE_CI=GREEN
```

requires the broader M3 contract as well: provenance, tracked-secret boundary, build, accepted regression gates, diff hygiene, and tracked-worktree cleanliness all pass. A green runner alone is not M3 completion.

## 3. Scope

### In scope

- repository-level self-hosted GitHub Actions runner for the private repository;
- Windows x64 development workstation as the runner host;
- dedicated runner label `xauusd-core-ci`;
- canonical workflow `.github/workflows/private-master-core-ci.yml`;
- static contract test for the workflow;
- exact dependency installation from the committed lockfile;
- workspace build;
- Phase7C targeted ownership/lifecycle regression;
- Telegram lifecycle regression;
- root `pnpm test` as broader private regression evidence;
- private bootstrap provenance verification;
- tracked-secret boundary implementation and verification;
- diff hygiene and exact-head evidence;
- documentation for runner registration, service lifecycle, verification, and safe removal.

### Out of scope

- production deployment or rollout;
- MT5 login/account changes;
- bot mode, ARM, task, process, order, or position mutation;
- LIVE test orders;
- migration of every legacy workflow to self-hosted;
- weakening or deleting unrelated failing tests;
- changing trading strategy, +6/+10, FastMove, M5, SEMI, Trend, Sideway, or risk behavior;
- storing production credentials, signing keys, MT5 secrets, Telegram secrets, or customer secrets on the runner for CI convenience;
- making root `pnpm lint` an M3 acceptance requirement while its separately known tracked `apps/web/.ignored_node_modules` blocker remains unresolved.

## 4. Chosen architecture

```text
PRIVATE REPOSITORY
      |
      v
.github/workflows/private-master-core-ci.yml
      |
      | runs-on:
      |   self-hosted
      |   Windows
      |   X64
      |   xauusd-core-ci
      v
Dedicated Windows development runner
      |
      +--> checkout exact head
      +--> pnpm 10.18.0
      +--> Node 24
      +--> frozen install
      +--> provenance / tracked-secret gates
      +--> workspace build
      +--> scoped Phase7C regressions
      +--> root pnpm test broader regression
      +--> diff hygiene / tracked-worktree cleanliness
      +--> fail-closed M3 verdict
```

The runner is repository-scoped, not organization-scoped. It is installed on a development workstation, not on the production bot host.

## 5. Runner host contract

Required labels:

```text
self-hosted
Windows
X64
xauusd-core-ci
```

Registration requirements:

- register only against `thiennguyen3004931-sudo/xauusd-ai-master-core`;
- obtain the registration token interactively from GitHub; never commit or paste it into repository files;
- keep runner binaries and `_work` outside the repository worktree;
- first verify interactively, then optionally install the runner as a Windows service;
- service account must not have MT5 trading credentials, production deployment credentials, signing keys, Telegram bot secrets, or customer secrets;
- no `.env` or production config is copied into the runner directory;
- removing the runner must not affect bot runtime.

## 6. Canonical workflow contract

Canonical path:

```text
.github/workflows/private-master-core-ci.yml
```

Required runner selector:

```yaml
runs-on: [self-hosted, Windows, X64, xauusd-core-ci]
```

Required permissions:

```yaml
permissions:
  contents: read
```

No deployment environment, repository secret, production credential, signing key, or write permission is permitted in this M3 workflow.

The canonical execution order is:

1. checkout the exact trusted PR/head with full history;
2. verify checked-out HEAD equals the expected head and print only non-sensitive runner OS/architecture/name metadata;
3. setup pnpm 10.18.0;
4. setup Node.js 24;
5. `pnpm install --frozen-lockfile`;
6. run the static workflow contract test;
7. run tracked-secret tests and tracked-secret scan;
8. run private bootstrap attestation tests and repository-backed provenance verification;
9. `pnpm build`;
10. run `scripts/test-phase7c-telegram-entry-resolution-lifecycle-contract.mjs`;
11. run Telegram regression suite:
    - `scripts/test-phase7c-telegram-lifecycle-observability-contract.mjs`;
    - `scripts/phase7c-trade-notifier-synthetic.test.mjs`;
    - `scripts/test-phase7c-hold-telegram-dedupe-contract.mjs`;
12. run root `pnpm test` as broader private regression evidence;
13. `git diff --check`;
14. verify no unexpected tracked worktree mutation remains;
15. emit `SELF_HOSTED_CI_INFRA=PASS` only after the infrastructure path has executed;
16. emit `M3_PRIVATE_CI=GREEN` only when M2 provenance and the true broader regression `outcome` are both successful.

The broader regression step may use `continue-on-error: true` only so later diagnostic/verdict steps still execute. The final M3 verdict must read `steps.broader_regression.outcome`, not the post-continue conclusion, and must exit non-zero when the outcome is not `success`.

## 7. Baseline regression resolution and gate semantics

During exact-head verification, root `pnpm test` reached `@xauusd/signal-engine` and two existing `SignalPipeline` expectations returned `WAIT` instead of BUY/SELL.

Investigation proved the production pipeline and thresholds were behaving as designed. The shared strong-confluence test fixture had drifted from the current contract:

- MA200 data required by MA20/MA50/MA200 confluence was missing;
- the bearish FVG was outside the accepted pullback distance (`> 0.5 ATR`).

The minimal repair was test-only:

```text
packages/signal-engine/tests/fixtures.ts
```

It added directionally aligned MA200 fixture data and moved the bearish FVG into the accepted pullback range. No `SignalPipeline`, strategy rule, threshold, executor, order, risk, or production runtime logic was changed.

After that alignment, exact-head root `pnpm test` passed and the fail-closed Full M3 acceptance verdict passed.

Root `pnpm lint` still has a separately known blocker because `apps/web/.ignored_node_modules` is tracked and ESLint traverses a TanStack package-local config importing `@tanstack/eslint-config`. This lint defect is not hidden, but it is not part of the approved M3 acceptance gate.

## 8. Tracked-secret boundary

Canonical files:

```text
scripts/security/check-private-secrets.mjs
scripts/security/check-private-secrets.test.mjs
```

The implementation rejects tracked private-key/credential material by path and high-confidence content signatures without printing secret values. Explicit `.env` example/sample templates are allowed by path but are still scanned for high-confidence secret content.

Minimum workflow commands:

```powershell
node --test scripts/security/check-private-secrets.test.mjs
node scripts/security/check-private-secrets.mjs --tracked
```

The runner workflow must not dump environment variables or secret-bearing files.

## 9. Provenance dependency

Canonical provenance files:

```text
security/private-bootstrap-attestation.json
scripts/security/verify-private-bootstrap.mjs
scripts/security/verify-private-bootstrap.test.mjs
scripts/security/write-private-bootstrap-attestation.mjs
```

The attestation records the accepted public bootstrap commit/tree and the identical private bootstrap commit/tree. Verification is fail-closed when:

- repository identities differ from the canonical public/private repositories;
- commit IDs differ;
- tree IDs differ;
- attestation values are malformed;
- the recorded private bootstrap tree does not match the actual Git object;
- the private bootstrap commit is not an ancestor of current HEAD.

The canonical workflow runs:

```powershell
node --test scripts/security/verify-private-bootstrap.test.mjs
node scripts/security/verify-private-bootstrap.mjs security/private-bootstrap-attestation.json
```

and blocks Full M3 acceptance on any provenance failure.

## 10. TDD / contract-first implementation

Canonical contract test:

```text
scripts/security/private-master-core-ci-contract.test.mjs
```

The contract requires:

- `.github/workflows/private-master-core-ci.yml` exists;
- `runs-on` contains `self-hosted`, `Windows`, `X64`, `xauusd-core-ci`;
- `contents: read` is present;
- exact trusted-head checkout and mismatch failure are present;
- Node is exactly 24;
- pnpm is exactly 10.18.0;
- install is exactly `pnpm install --frozen-lockfile`;
- tracked-secret gate is invoked;
- private bootstrap verifier is a mandatory Full M3 dependency;
- `pnpm build` is invoked;
- Phase7C targeted contract is invoked;
- all three Telegram regression files are invoked;
- root `pnpm test` broader regression is represented;
- blocked M3 verdicts fail the GitHub check and inspect the true broader `outcome`;
- `git diff --check` is invoked;
- GitHub-hosted labels such as `ubuntu-latest`, `windows-latest`, and `macos-latest` are absent;
- production mutation commands and secret injection are absent;
- Windows-specific steps use built-in `powershell`, not a PowerShell 7 dependency.

Implementation sequence:

```text
RED static contract
-> minimal self-hosted workflow
-> GREEN static contract
-> register runner
-> actual GitHub job with non-empty steps
-> scoped CI evidence
-> broader M3 regression
-> exact-head fail-closed Full M3 verdict
```

## 11. Trigger strategy

The canonical workflow uses these triggers only:

- `pull_request` targeting `main`;
- `workflow_dispatch` for explicit operator verification when available.

A branch `push` trigger is intentionally absent to avoid duplicate self-hosted runs for the same PR update. PR runs are coalesced with concurrency and `cancel-in-progress: true`.

Fork PRs are blocked from the self-hosted job by requiring either a non-PR event or a PR whose head repository is the same repository as the target.

No public-repository trigger is configured.

## 12. Security model

A self-hosted runner executes repository code on its host. Therefore:

- only trusted changes in this private repository may execute on it;
- public/fork PRs are not allowed onto this runner;
- no production secrets are stored on the host for CI;
- `GITHUB_TOKEN` remains read-only;
- registration token is transient setup data and is never written to Git history, logs, screenshots, or documentation;
- workflow steps must not print complete environment blocks;
- no CI step may invoke production lifecycle, deployment, ARM, order, or position mutation scripts.

## 13. Safety invariants

```text
PRODUCTION_MUTATION=NONE
BOT_RUNTIME_MUTATION=NONE
MODE_MUTATION=NONE
ARM_MUTATION=NONE
TASK_MUTATION=NONE
PROCESS_MUTATION=NONE
ORDER_MUTATION=NONE
POSITION_MUTATION=NONE
LIVE_TEST_ORDER=NONE
```

Any command whose effect is not demonstrably source/build/test/read-only is excluded from this M3 change.

## 14. Acceptance evidence

### Self-hosted infrastructure accepted

`SELF_HOSTED_CI_INFRA=PASS` requires all of:

1. repository-level runner executes the job;
2. runner carries label `xauusd-core-ci`;
3. workflow is assigned to that runner;
4. GitHub job step list is non-empty;
5. exact-head checkout/setup/test steps execute;
6. static workflow contract passes;
7. no production mutation or secret exposure occurs.

### Full M3 accepted

`M3_PRIVATE_CI=GREEN` additionally requires:

1. M2 provenance attestation verifier passes;
2. tracked-secret boundary passes;
3. frozen dependency install passes;
4. workspace build passes;
5. Phase7C targeted suite passes;
6. Telegram regression passes;
7. root `pnpm test` broader private regression passes;
8. `git diff --check` passes;
9. no unexpected tracked worktree mutation remains;
10. production remains untouched.

An offline/unassigned runner, empty step list, exact-head mismatch, failed provenance, failed secret boundary, failed build/regression, dirty tracked worktree, or failed diff hygiene means the corresponding gate remains not green.

### Accepted exact-head evidence

The first fully accepted exact-head run before this documentation alignment was:

```text
EXACT_HEAD=0860508bb05639d8be79b9a9a94495766ef80a7f
SELF_HOSTED_RUN_ID=35055266991
RUNNER=XAUUSD-CORE-CI-WIN
JOB_CONCLUSION=SUCCESS
BROAD_PRIVATE_REGRESSION=PASS
SELF_HOSTED_CI_INFRA=PASS
FULL_M3_ACCEPTANCE=PASS
M3_PRIVATE_CI=GREEN
```

Any subsequent documentation/source commit becomes the new exact head and must re-run the same canonical gate before replacing this evidence.

## 15. Legacy workflow policy

This change does not mass-edit existing workflows.

After the canonical private Master/Core gate executes successfully, legacy workflows may be migrated or consolidated only in separate reviewed changes. Existing tests are not weakened merely to make old workflows green.

Legacy workflow failures outside the canonical M3 workflow are not silently reclassified as M3 success; they remain separate migration/consolidation work.

## 16. Rollback and removal

Rollback is source/infrastructure-only:

- disable/remove `.github/workflows/private-master-core-ci.yml`;
- stop the Windows runner service;
- deregister the repository-level runner;
- delete the local runner directory after deregistration if no longer needed.

Rollback must not require any bot restart, MT5 change, trading-mode change, scheduled-task mutation, order mutation, or position mutation.

## 17. Completion definition

This design is implemented when the private repository has one canonical self-hosted execution path that proves exact-head CI execution without GitHub-hosted minutes and satisfies the broader M3 provenance/secret/build/regression contract.

M3 does not authorize public-repository sanitization, production cutover, or trading-runtime changes by itself.
