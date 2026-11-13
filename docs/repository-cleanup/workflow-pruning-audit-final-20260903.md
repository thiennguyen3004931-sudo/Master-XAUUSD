# Workflow pruning final reachability audit — 2026-09-03

## Scope

Source-only repository governance audit on canonical `main@daeac846087234419800cafa0ebcddafddd1c3f2` after pruning batches 1–3.

Runtime/trading mutation remained out of scope:

- ORDER_MUTATION=NONE
- LIVE_TEST_ORDER=NONE
- MODE_CHANGE=NONE
- ARM_CHANGE=NONE
- BRIDGE_RESTART=NONE
- EXECUTOR_RESTART=NONE
- WEB_API_RESTART=NONE
- RUNTIME_DEPLOYMENT=NONE

## Generic reachability contract

The permanent repository pruning contract now audits every remaining `.github/workflows/*.yml` / `.yaml` file and requires at least one trigger reachable under the canonical main-only branch topology.

The audit deliberately fails open for complex/unknown branch glob syntax and treats manual, scheduled, reusable, tag-based, and other non-branch-scoped events as reachable. Its purpose is only to prove workflows that are definitely branch-dead; it must not over-delete workflows that retain another valid role.

## Fresh RED evidence

PR #235 RED head: `408752b026055b1c478576f51469dda9971707c4`.

Canonical Linux failed only at `Repository workflow pruning contract` with the complete branch-dead set:

1. `phase7c-startup-runner-guard-ci.yml`
2. `phase7c-web-account-switch-ci.yml`
3. `phase7c-web-live-start-guard-ci.yml`
4. `phase7c-web-mt5-sync-demo-e2e-ci.yml`

Direct YAML inspection confirmed the result:

- `phase7c-startup-runner-guard-ci.yml`: push only to `fix/phase7c-startup-runner-singleton` / `fix/phase7c-startup-acceptance-verifier`; PR only to `fix/phase7c-legacy-background-cleanup`.
- `phase7c-web-account-switch-ci.yml`: push only to `feat/phase7c-guarded-web-account-switch`; PR only to `fix/phase7c-legacy-background-cleanup`.
- `phase7c-web-live-start-guard-ci.yml`: PR only to `fix/phase7c-legacy-background-cleanup`.
- `phase7c-web-mt5-sync-demo-e2e-ci.yml`: PR only to `fix/phase7c-legacy-background-cleanup`.

Repository consolidation leaves only `main`, so those trigger branches are unreachable. None of the four workflows defines `workflow_dispatch`, `schedule`, `workflow_call`, tag-trigger fallback, or another live event.

## GREEN implementation

Delete exactly the four proven-dead workflows above. Preserve their names in the explicit retired-workflow list and preserve the generic reachability audit as an anti-regression guard.

No trading source, runtime deployment helper, executor, bridge, API, Web, MT5 panel, risk configuration, order path, mode, or ARM state is modified by this batch.

## Final expected pruning state

- Batch 1 retired workflows: 3
- Batch 2 retired workflows: 4
- Batch 3 retired workflows: 6
- Final batch retired workflows: 4
- Total retired workflows: 17

The final batch is complete only after fresh exact-head canonical Linux and Windows checks are GREEN, PR #235 is merged through protected `main`, the post-merge push gate is GREEN, and the merged branch content is verified before branch cleanup.
