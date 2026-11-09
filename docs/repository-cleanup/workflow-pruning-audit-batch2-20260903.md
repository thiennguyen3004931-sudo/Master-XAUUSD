# Workflow Pruning Audit — Batch 2 — 2026-09-03

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
main@df915fb4024907d03eb803002382dc1628849f69
```

Ruleset preserved:

```text
RULESET_ID=22166843
REQUIRED_CHECKS=canonical-pr-linux,canonical-pr-windows
```

## Deletion rule

A workflow is removed only when its current YAML and current repository topology prove that it has no remaining execution target. A historical `push` branch alone is not sufficient if the workflow still has a valid `pull_request` target for `main` or another current responsibility.

## Removed workflows

### `phase7c-demo-target-live-env-disabled-ci.yml`

- `push` is restricted to `fix/phase7c-demo-migration-live-env-disabled`.
- `pull_request` is restricted to `fix/phase7c-legacy-background-cleanup`.
- Both branches were removed during repository consolidation.
- No unrestricted PR trigger, `main` PR trigger, or `workflow_dispatch` fallback exists.

Conclusion: unreachable under current repository topology.

### `phase7c-switch-position-array-ci.yml`

- `push` is restricted to `fix/phase7c-switch-empty-position-array-pr`.
- `pull_request` is restricted to `fix/phase7c-legacy-background-cleanup`.
- Both branches were removed during repository consolidation.
- No valid current fallback exists.

Conclusion: unreachable under current repository topology.

### `phase7c-stale-port-ownership-ci.yml`

- `push` is restricted to `fix/phase7c-stale-port-ownership`.
- `pull_request` is restricted to `fix/phase7c-legacy-background-cleanup`.
- Both branches were removed during repository consolidation.
- No valid current fallback exists.

Conclusion: unreachable under current repository topology.

### `phase7c-scheduled-task-ownership-ci.yml`

- `push` is restricted to `fix/phase7c-scheduled-task-ownership`.
- `pull_request` is restricted to `fix/phase7c-legacy-background-cleanup`.
- Both branches were removed during repository consolidation.
- No valid current fallback exists.

Conclusion: unreachable under current repository topology.

## Explicitly retained during this audit

The following inspected workflows were retained because they still have valid PR coverage into `main` or unrestricted PR coverage and execute distinct regression contracts:

- `phase7c-live-canonical-recovery-runtime-deploy-ci.yml`
- `phase7c-sideway-runtime-safe-deploy-ci.yml`
- `phase7c-web-ui-safe-deploy-ci.yml`
- `phase7c-executor-stop-order-ci.yml`
- `phase7c-sideway-fetch-observability-ci.yml`
- `phase7c-ui-current-wait-reason-freshness-ci.yml`
- `phase7c-account-runtime-system-broker-verifier-ci.yml`
- `phase7c-account-switch-canonical-lifecycle-ci.yml`
- `phase7c-auto-active-ui-authorization-semantics-ci.yml`
- `phase7c-managed-volume-reconcile-ci.yml`
- `phase7c-lifecycle-caller-provenance-ci.yml`
- `phase7c-trend-singleton-ownership-ci.yml`
- `phase7c-web-account-semantic-ci.yml`
- `phase7c-live-runtime-inspector-ci.yml`

## Permanent anti-regression contract

`scripts/test-repository-workflow-pruning-contract.mjs` now includes all seven retired workflows from pruning batches 1 and 2. The always-on `canonical-pr-linux` job executes this contract on every PR into `main`, preventing these dead workflow definitions from being restored silently.
