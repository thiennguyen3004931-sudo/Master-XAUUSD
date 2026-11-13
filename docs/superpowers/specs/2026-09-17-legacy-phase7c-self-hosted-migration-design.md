# Legacy Phase7C Self-Hosted Migration Design

## Purpose

Migrate the three remaining legacy Phase7C GitHub Actions workflows from GitHub-hosted runners to the already-proven private Windows self-hosted runner without weakening any test, shell, security, or trading-safety contract. During real self-hosted acceptance, the canonical pruning gate exposed one stale branch-only TDD workflow; after explicit user approval, that temporary workflow is retired as the only scope expansion.

## Proven prerequisite

PowerShell 7 capability was proven on the canonical runner before this migration:

```text
PROBE_PR=10
PROBE_HEAD=f229162fe05c8b56ae14a897006226ec53fa036c
PROBE_RUN=35186137537
PROBE_JOB=105088493138
RUNNER=XAUUSD-CORE-CI-WIN
RUNNER_VERSION=2.337.0
POWERSHELL_51_VERSION=5.1.26100.9444
PWSH_FOUND=TRUE
PWSH_VERSION=7.6.6
PWSH_DIRECT_EXECUTION=PASS
PWSH_ACTIONS_SHELL=PASS
JOB_CONCLUSION=SUCCESS
```

## Exact scope

Runner migration is limited to these three workflow files:

```text
.github/workflows/phase7c-canonical-pr-gate.yml
.github/workflows/phase7c-live-arm-orphan-reconciliation-ci.yml
.github/workflows/phase7c-web-live-arm-demo-auto-ci.yml
```

For those three files, only the `runs-on` selectors may change.

The only additional repository mutation authorized after RED evidence is deletion of this stale temporary workflow:

```text
.github/workflows/phase7c-broker-desired-state-persistence-tdd.yml
```

The migration branch is:

```text
ci/migrate-legacy-phase7c-self-hosted
```

Base commit:

```text
62e93ce5545195dd6bf78570c9b5fc0f4b253399
```

## Chosen architecture

Replace every GitHub-hosted runner selector in the three legacy workflows with the existing canonical runner labels:

```yaml
runs-on: [self-hosted, Windows, X64, xauusd-core-ci]
```

Preserve in those workflows:

- workflow names;
- job identifiers;
- job display names/check names;
- triggers;
- permissions;
- timeouts;
- checkout steps;
- Node, pnpm, Python setup;
- every build/test/source-contract command;
- every `shell: pwsh` step;
- every `shell: powershell` step;
- diff hygiene and pruning gates.

No step may be deleted, skipped, weakened, or changed to `continue-on-error` to obtain GREEN.

## TDD acceptance sequence

### RED — hosted runner failure

Open the migration PR before changing runner selectors. The three legacy workflows retain GitHub-hosted selectors and reproduce the pre-step hosted-runner failure. Exact RED evidence was captured at:

```text
RED_HEAD=4b18572debe537c8a57327ad1a9ca33e305f4111
CANONICAL_RUN=35191026903
LIVE_ARM_ORPHAN_RUN=35191026894
WEB_LIVE_ARM_RUN=35191026914
ALL_SEVEN_JOBS_FAILED_WITH_STEPS_NULL=TRUE
```

### Minimal migration

Apply only the runner-selector migration in the three legacy workflows. Real jobs must then execute on the private self-hosted runner with all original commands and shell contracts preserved.

### Discovered pruning blocker and approved cleanup

At migration head `9eb69ee602ad85ed80a4cf86c9beef7b6b1ffad7`, real self-hosted execution proved the runner migration itself worked. `canonical-pr-windows` passed, while the other canonical job reached the repository pruning contract and failed only with:

```text
RUN=35191122309
JOB=105103707494
Repository workflow pruning contract=FAIL
RED_TARGET: branch-dead workflows remain: phase7c-broker-desired-state-persistence-tdd.yml
```

The identified workflow triggered only on `fix/phase7c-broker-desired-state-persistence`. That branch still existed, but there was no open PR from it. The user explicitly approved cleanup of this temporary workflow. Therefore deletion of `.github/workflows/phase7c-broker-desired-state-persistence-tdd.yml` is the only approved scope expansion and is recorded in a separate cleanup commit on PR #12.

### GREEN

At cleanup head `d2a7d0651a94de9c370315341d749db259e1f58d`, exact-head self-hosted acceptance passed:

```text
Private Master Core Self-Hosted CI      RUN=35196275806 PASS
Phase7C LIVE Arm Orphan Reconciliation RUN=35196275821 PASS
Phase7C Web LIVE Arm + DEMO Auto       RUN=35196275830 PASS
Phase7C Canonical PR Gate              RUN=35196275786 PASS
  canonical-pr-windows JOB=105120149146 PASS
  canonical-pr-linux   JOB=105120149534 PASS
  Repository workflow pruning contract PASS
```

A fresh exact-head verification is still required after documentation alignment before final review status is declared.

`Public Private Repository Boundary CI` remains a separate private-repository topology issue owned by PR #9. It is not removed, weakened, bypassed, or reclassified as passing in this migration PR.

## Safety invariants

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
TRADING_LOGIC_MUTATION=NONE
RISK_LOGIC_MUTATION=NONE
ORDER_LOGIC_MUTATION=NONE
ALLOWLIST_MUTATION=NONE
GITLEAKS_MUTATION=NONE
WORKFLOW_SECURITY_DOWNGRADE=NONE
PS7_GATE_REMOVED=FALSE
PS5_FALLBACK_USED_TO_BYPASS_PS7=FALSE
PR9_MUTATION=NONE
PR7_MUTATION=NONE
PR10_MERGE=NONE
```

## Merge boundary

PR #12 remains unmerged until fresh exact-head GREEN evidence is captured after this documentation alignment and the final diff confirms only:

1. the three authorized `runs-on` migrations;
2. deletion of the explicitly approved stale branch-only TDD workflow; and
3. migration design/plan documentation.

PR #9 and PR #7 are not modified as part of this migration. The separate Public/Private Repository Boundary CI failure must be handled through its own topology work rather than by weakening this migration acceptance.
