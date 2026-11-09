# Workflow Pruning Audit — 2026-09-03

## Scope

Repository governance only. No trading runtime mutation was performed.

```text
ORDER_MUTATION=NONE
LIVE_TEST_ORDER=NONE
MODE_CHANGE=NONE
ARM_CHANGE=NONE
BRIDGE_RESTART=NONE
EXECUTOR_RESTART=NONE
WEB_API_RESTART=NONE
RUNTIME_DEPLOYMENT=NONE
```

Canonical protected branch at audit start:

```text
main@d2bc1a591acb52e5c7a3e85ba26f2fdb27333b05
```

The repository ruleset remains responsible for requiring:

- `canonical-pr-linux`
- `canonical-pr-windows`

This pruning batch does not change those context names.

## Deletion rule

A workflow is deleted only when its own current YAML plus current repository branch topology prove that it has no valid remaining execution target or responsibility. Name age, Phase7B/Phase7C labels, or partial overlap with the canonical PR gate are not sufficient reasons for deletion.

## Removed workflows

### `.github/workflows/phase7b-live-runtime-status-ci.yml`

Evidence:

- The workflow has only a `pull_request` trigger.
- That trigger is restricted to base branch `fix/phase7c-legacy-background-cleanup`.
- Repository consolidation removed that branch; canonical remote topology before this pruning branch was created was `main` only.
- The workflow has no `pull_request` target for `main`, no `push` target for `main`, and no `workflow_dispatch` fallback.

Conclusion: unreachable under current repository topology.

### `.github/workflows/phase7b-pattern-rule-v2-apply.yml`

Evidence:

- Push trigger is restricted to deleted branch `phase7c-sideway-supply-demand`.
- Manual `workflow_dispatch` exists, but the job hard-codes checkout `ref: phase7c-sideway-supply-demand`.
- The workflow also hard-codes its write-back target as `git push origin HEAD:phase7c-sideway-supply-demand`.
- The target branch no longer exists after canonical repository consolidation.

Conclusion: manual execution cannot perform its declared job against current topology; keeping it would expose a misleading write-capable workflow targeting a retired branch.

### `.github/workflows/phase7b-pattern-rule-v2-recovery-ci.yml`

Evidence:

- Push trigger is restricted to deleted branch `phase7c-sideway-supply-demand`.
- Manual `workflow_dispatch` hard-codes checkout of that same deleted branch.
- Recovery commit step hard-codes push back to that deleted branch.

Conclusion: obsolete branch-recovery workflow with no valid current target.

## Explicitly retained after content audit

### `.github/workflows/phase7b-pattern-rule-v2-ci.yml`

Retained because it still has a `pull_request` trigger and performs migration checks, canonical Pattern Rule V2 application in CI checkout, risk-engine build/typecheck/tests, API build, and TypeScript transform validation.

### `.github/workflows/phase7b-pattern-ui-clock-ci.yml`

Retained because it still has `pull_request` coverage and verifies UI clock migration, API/Web builds, clock normalization, and current Semantic UI compatibility.

### `.github/workflows/phase7b-supertrend-entry-gates-ci.yml`

Retained because it still has `pull_request` coverage and carries broad Supertrend/canonical-runner/CRLF/build validation not represented by the pruning contract.

### `.github/workflows/phase7b-web-job-object-cleanup-ci.yml`

Retained because it still targets pull requests to `main` for Windows Job Object cleanup regressions in both PowerShell 7 and Windows PowerShell 5.1.

### Dedicated Phase7C workflows

Retained unless separately proven dead. Partial overlap with the canonical gate is not enough to prune them. For example:

- `phase7c-canonical-daily-recovery-executors-ci.yml` includes syntax coverage outside the current canonical gate.
- `phase7c-structural-sl-monotonicity-ci.yml` includes ledger, broker-day, notifier, HOLD M15, forward-report, and dependency-graph regressions beyond the canonical gate.
- `phase7c-web-live-arm-demo-auto-ci.yml` includes a production Node API runtime smoke test beyond the canonical gate.

## Permanent anti-regression contract

`scripts/test-repository-workflow-pruning-contract.mjs` is executed by the always-on `canonical-pr-linux` job. It requires the three retired workflow files to remain absent and requires the canonical PR gate itself to remain present.

This prevents future branch-history cleanup or cherry-picks from silently restoring these dead workflow definitions.
