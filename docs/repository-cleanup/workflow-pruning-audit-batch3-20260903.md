# Workflow Pruning Audit — Batch 3 — 2026-09-03

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
main@a9e2d7cb206e3e01846e12011578ccd929a00b22
```

Ruleset preserved:

```text
RULESET_ID=22166843
REQUIRED_CHECKS=canonical-pr-linux,canonical-pr-windows
```

## Deletion rule

A workflow is removed only when current YAML plus current repository topology prove it has no remaining execution target. Historical branch-scoped `push` plus a `pull_request` target that also points only to a deleted branch is considered unreachable when there is no valid `main` PR trigger, unrestricted PR trigger, or `workflow_dispatch` fallback.

## Removed workflows

### `phase7c-live-capability-ci.yml`

- `push` targets only `feat/phase7c-live-capability-gate`.
- `pull_request` targets only `fix/phase7c-legacy-background-cleanup`.
- Both branches were removed during repository consolidation.
- No `workflow_dispatch` fallback exists.

Conclusion: unreachable under current repository topology.

### `phase7c-live-readonly-probe-ci.yml`

- `push` targets only `feat/phase7c-live-readonly-probe`.
- `pull_request` targets only `fix/phase7c-legacy-background-cleanup`.
- Both branches are absent.
- No current fallback exists.

Conclusion: unreachable.

### `phase7c-live-activation-preflight-ci.yml`

- `push` targets only `feat/phase7c-live-activation-preflight`.
- `pull_request` targets only `fix/phase7c-legacy-background-cleanup`.
- Both branches are absent.
- No current fallback exists.

Conclusion: unreachable.

### `phase7c-live-arm-guard-ci.yml`

- `push` targets only `feat/phase7c-dual-terminal-live-arm-guard`.
- `pull_request` targets only `fix/phase7c-legacy-background-cleanup`.
- Both branches are absent.
- No current fallback exists.

Conclusion: unreachable.

### `phase7c-live-risk-profile-ci.yml`

- `push` targets only `feat/phase7c-live-risk-profile-guard`.
- `pull_request` targets only `fix/phase7c-legacy-background-cleanup`.
- Both branches are absent.
- No current fallback exists.

Conclusion: unreachable.

### `phase7c-dual-account-mode-ci.yml`

- All listed `push` targets are historical feature/fix branches removed during repository consolidation.
- `pull_request` targets only `fix/phase7c-legacy-background-cleanup`, which is also absent.
- No valid `main` PR trigger, unrestricted PR trigger, or `workflow_dispatch` fallback exists.

Conclusion: unreachable.

## Explicitly retained during this audit

The following inspected workflows remain reachable and keep distinct regression responsibility, so they were not pruned:

- `phase7b-web-job-object-cleanup-ci.yml` — PRs into `main`.
- `phase7c-account-runtime-system-broker-verifier-ci.yml` — PRs into `main`.
- `phase7c-account-switch-canonical-lifecycle-ci.yml` — PRs into `main`.
- `phase7c-auto-active-ui-authorization-semantics-ci.yml` — PRs into `main`.
- `phase7c-bot-mode-provenance-ci.yml` — PRs into `main`.
- `phase7c-executor-stop-order-ci.yml` — unrestricted PR trigger.
- `phase7c-lifecycle-caller-provenance-ci.yml` — PRs into `main`.
- `phase7c-live-fail-closed-runtime-recovery-ci.yml` — unrestricted PR trigger.
- `phase7c-live-magic-attribution-guard-ci.yml` — PRs into `main`.
- `phase7c-live-runtime-inspector-ci.yml` — PRs into `main`.

## Permanent anti-regression contract

`scripts/test-repository-workflow-pruning-contract.mjs` now includes all thirteen workflows retired across pruning batches 1–3. The always-on `canonical-pr-linux` job executes this contract on every PR into `main`, preventing these unreachable workflow definitions from being silently restored.
