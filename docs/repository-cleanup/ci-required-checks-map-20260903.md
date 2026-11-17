# Canonical CI Required-Checks Map — 2026-09-03

## Scope

This is repository governance only. It does not deploy or mutate the trading runtime.

Runtime invariants:

- ORDER_MUTATION=NONE
- LIVE_TEST_ORDER=NONE
- MODE_CHANGE=NONE
- ARM_CHANGE=NONE
- BRIDGE_RESTART=NONE
- EXECUTOR_RESTART=NONE
- WEB_API_RESTART=NONE
- RUNTIME_DEPLOYMENT=NONE

## Current CI shape

The repository retains many focused Phase7B/Phase7C workflows. Most are intentionally scoped with `paths` filters and therefore are not safe as universal required status checks: an unrelated pull request can legitimately skip them and leave a required context pending forever.

Examples include:

- `phase7c-fixed-tp-additive-ci.yml`
- `phase7c-canonical-daily-recovery-executors-ci.yml`
- `phase7c-structural-sl-full-ci.yml`
- `phase7c-strategy-entry-conditions-ci.yml`

Focused workflows remain valuable regression gates and are intentionally retained. Workflow deletion is out of scope for this change.

## Canonical always-on gate

`.github/workflows/phase7c-canonical-pr-gate.yml` runs on every pull request targeting `main` and every push to `main` with no `paths` or `paths-ignore` filters.

Stable check contexts:

1. `canonical-pr-linux`
2. `canonical-pr-windows`

### `canonical-pr-linux`

Covers the baseline that must never depend on the changed-file set:

- frozen workspace install;
- broker/risk/strategy build and package tests;
- strategy entry condition core contract;
- Trend entry recovery contract;
- Sideway recovery management contract;
- canonical Daily Recovery executor contract;
- structural SL monotonicity and Sideway execution regressions;
- shared execution lock regression;
- broker-native Fixed TP Trend/Sideway regressions;
- API and Web dependency-graph builds;
- canonical controller syntax checks;
- `git diff --check`.

### `canonical-pr-windows`

Covers Windows-specific source and lifecycle safety in both PowerShell 7 and Windows PowerShell 5.1 where applicable:

- lifecycle broker source contract;
- lifecycle broker protocol contract;
- lifecycle broker ACL source contract;
- Web LIVE ARM / DEMO AUTO source contract;
- activation safety source contract;
- LIVE risk-profile fail-closed source contract;
- `git diff --check`.

## Required-check policy after this PR is GREEN and merged

Only these two stable contexts should be configured as required status checks for `main`:

- `canonical-pr-linux`
- `canonical-pr-windows`

Focused/path-filtered workflows must remain non-required supplementary checks.

Recommended branch governance:

- require pull requests before changes reach `main`;
- require the two canonical status checks;
- require the branch to be up to date before merge;
- block force pushes;
- block branch deletion;
- do not require a human approval count unless a reliable reviewer is available;
- do not configure deployment/runtime workflows as merge requirements.

## Activation gate

Do not create or enable the `main` ruleset until:

1. this workflow has run on its own pull request;
2. both `canonical-pr-linux` and `canonical-pr-windows` are `completed/success` on the exact PR head;
3. the PR is merged;
4. the same two contexts are observed from the merged workflow contract and can be referenced by GitHub ruleset configuration.
