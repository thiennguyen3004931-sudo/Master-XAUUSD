# Phase7C stopped-lifecycle Web-only rollout plan

Base source:

- commit: `5b02788b67439e2ab28c1ce8f787d73afb2854fe`
- tree: `40fb6ae22879ea3a796acb3e6d4f341ebca66833`

## Goal

Provide two narrowly scoped canonical operator entrypoints without weakening the existing strict dashboard deployment path:

1. A provenance-only deployment identity initializer.
2. A stopped-lifecycle Web-only reload path for `XAUUSD-Phase7B-Web`.

## Immutable safety invariants

- `MODE_MUTATION=NONE`
- `ARM_MUTATION=NONE`
- `BRIDGE_RESTART=NONE`
- `EXECUTOR_RESTART=NONE`
- `ORDER_MUTATION=NONE`
- `LIVE_TEST_ORDER=NONE`
- Existing strict dashboard deployment contracts remain unchanged.
- Stopped-lifecycle Web-only reload must fail closed unless mode is `PAUSE`, ARM is disarmed, lifecycle is stopped, executor/supervisor processes are not alive, XAUUSD positions are zero, XAUUSD pending orders are zero, and accepted deployment identity is consistent.
- Post-reload checks must prove the same mode/ARM/lifecycle/order/position invariants, unchanged Bridge identity, zero executor generation, Web task scope only, and API/Web deployment provenance consistency.

## TDD sequence

### Task 1 — RED: provenance-only initializer contract

Create `scripts/test-phase7c-runtime-source-initialize-only-source.ps1` requiring a new `scripts/initialize-phase7c-runtime-source-deployment-local.ps1` entrypoint. The production entrypoint must call `Initialize-Phase7CRuntimeSourceDeployment` and must not contain task/process/runtime/order mutations or invoke recovery/dashboard deployment.

### Task 2 — GREEN: provenance-only initializer

Implement only the minimum source identity resolution and canonical deployment initialization needed to produce/reuse the deployment identity. No HTTP calls and no Scheduled Task/process operations.

### Task 3 — RED: stopped-lifecycle Web-only contract

Create `scripts/test-phase7c-stopped-lifecycle-web-only-source.ps1` requiring `scripts/deploy-phase7c-stopped-lifecycle-web-only-local.ps1`. Require explicit STOPPED lifecycle pre/post gates, zero XAUUSD positions/orders pre/post, PAUSE + DISARMED pre/post invariants, protected Bridge/executor identity checks, and exclusive `XAUUSD-Phase7B-Web` task scope.

### Task 4 — GREEN: stopped-lifecycle Web-only implementation

Implement the narrow Web/API reload path without calling the strict dashboard deployment helper that requires a live executor generation. Do not start/restart Bridge, supervisor, trend executor, or sideway executor.

### Task 5 — regression verification

Run the two new contracts plus existing dashboard safe-deploy, stopped-lifecycle pre-Web generation, generation reconciliation, live-readonly-probe, and runtime source-attestation tests. Existing strict deployment behavior must remain intact.

### Task 6 — PR/CI

Open a PR only after RED evidence is captured and GREEN implementation is committed. Keep runtime rollout blocked until a connected production terminal can re-snapshot PAUSE/DISARMED/STOPPED, confirm zero XAUUSD positions/orders, and execute the post-acceptance probes.
