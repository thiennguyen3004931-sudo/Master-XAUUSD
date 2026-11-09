# XAUUSD AI MASTER Repository Consolidation Design

Date: 2026-09-02

## Objective

Keep the currently deployed XAUUSD AI MASTER production system unchanged while reducing repository ambiguity, stale scopes, and accidental source/deploy selection risk.

Canonical production truth at the start of this cleanup:

- Repository: `thiennguyen3004931-sudo/xauusd-ai-master`
- Branch: `main`
- SHA: `69ed572fc0232fae228534d5cf7f73e0b2b282db`
- Runtime deployment: already completed separately before this cleanup
- Runtime mode/ARM/order state is out of scope for repository cleanup

## Current repository hygiene problem

The GitHub account has one XAUUSD production repository. The other accessible repositories are unrelated customer projects and are out of scope.

The XAUUSD repository currently has about 252 remote branches accumulated from research, RED/impl iterations, review variants, old features, fixes, temporary checkpoints, and historical phases. It also has 9 open pull requests, including scopes that are stale, superseded, or no longer part of the canonical production line.

This creates four risks:

1. A future review can inspect the wrong branch and mistake stale behavior for production behavior.
2. A deploy or comparison can accidentally use an obsolete SHA or branch.
3. Old open PRs can be mistaken for current approved work.
4. Runtime-generated files can make the worktree dirty and block guarded deployment.

## Chosen strategy: aggressive consolidation

The user selected option A: keep one production truth and remove stale working refs.

After cleanup, repository policy is:

- `main` is the only permanent production branch.
- A small number of short-lived branches may exist only while active work is in progress.
- Merged, superseded, RED-only, impl-only, review, temporary, old phase, and abandoned branches are deleted after archival safety checks.
- Stale/superseded open pull requests are closed rather than left as active scopes.
- Historical pull-request and commit records remain available through GitHub history where applicable.

## Safety archive before destructive branch deletion

Before deleting remote branches, create a full Git bundle outside the working repository. This preserves all current refs and commits without keeping hundreds of remote branch names in GitHub.

Recommended local archive path:

`F:\Project\XAUUSD_AI_MASTER\archive\xauusd-ai-master-pre-cleanup-20260902.bundle`

Required archive procedure:

1. Fetch and prune remote metadata.
2. Create the bundle with `git bundle create <path> --all`.
3. Verify it with `git bundle verify <path>`.
4. Record the pre-cleanup branch inventory as `branch-name -> SHA` in a repository manifest.
5. Only after bundle verification and manifest creation may remote branch deletion start.

The bundle is deliberately stored outside the repository so it does not bloat or confuse production source.

## Branch retention policy

### KEEP

- `main`
- `chore/repo-consolidation-20260902` only until this cleanup PR is merged; then delete it too.
- Any branch created after this design is approved only if it corresponds to one explicitly active task.

### DELETE AFTER ARCHIVE

All other pre-cleanup branches unless a fresh explicit exception is recorded before deletion. This includes, but is not limited to:

- `*-red`
- `*-impl`
- `*-review`, `*-review2...`
- `*-pr`, `*-final`, `*-check`
- `tmp-*`, `noop-*`
- old `design/*`, `feature/*`, `feat/*`, `fix/*`, `test/*`, `codex/*`, `release/*`, sprint branches, and historical Phase3/Phase4/Phase7B checkpoints
- merged M5 trailing branches now superseded by `main@69ed572f...`

The rule is based on canonicality, not branch name: if it is not `main` and not a currently approved active task, it is not a production source of truth.

## Pull request cleanup

At design time there are 9 open PRs. Under option A, all pre-cleanup open PRs are treated as stale scopes unless explicitly re-approved after this consolidation.

The cleanup will close them with a short note that the repository has been consolidated onto current `main` and that the PR is not an active production source. Closing a PR does not mutate LIVE runtime and does not merge its changes.

In particular, old M5 trailing PR #225 is superseded by merged PR #226/current main and must be closed.

## Workflow cleanup

Workflow files are not deleted in the first destructive pass merely because they are old. CI workflows can still provide regression coverage for current behavior.

Workflow consolidation therefore happens in a second source-only pass:

1. Build a workflow-to-contract map.
2. Mark workflows as current regression, redundant, obsolete, or deploy-only.
3. Remove only workflows whose coverage is duplicated or whose target source no longer exists.
4. Re-run the retained canonical regression suite before merge.

This avoids weakening safety while reducing GitHub Actions noise.

## Runtime artifact hygiene

The current Sideway account wrapper generates temporary files matching:

`/scripts/.phase7c-sideway-runtime-*.mjs`

These are runtime artifacts and are not source. The canonical `.gitignore` should ignore this exact pattern so future guarded deployments do not fail because a running/previous Sideway process left one behind.

The current local `.git/info/exclude` workaround can remain temporarily, but the repository-level ignore rule becomes canonical after merge.

## Main branch governance

The desired end-state is:

- default branch: `main`
- direct production development on stale branches: eliminated
- all future work starts from fresh `main`
- exact-SHA deployment remains mandatory
- branch names are deleted after merged/abandoned work
- stale PRs are not left open as pseudo-scopes

If repository permissions allow it, branch protection/rules should be enabled for `main` so normal source changes flow through PR + CI rather than accidental direct updates.

## Runtime safety boundary

Repository cleanup must never perform trading/runtime mutations.

For the entire cleanup:

- `ORDER_MUTATION=NONE`
- `LIVE_TEST_ORDER=NONE`
- `MODE_CHANGE=NONE`
- `ARM_CHANGE=NONE`
- `BRIDGE_RESTART=NONE`
- `EXECUTOR_RESTART=NONE`
- `WEB_API_RESTART=NONE`
- `RUNTIME_DEPLOYMENT=NONE`

The already deployed LIVE runtime continues unchanged while GitHub references and source hygiene are cleaned.

## Verification / success criteria

The cleanup is complete when:

1. `main` remains the canonical production branch and has not been rewritten.
2. A verified external Git bundle exists for the pre-cleanup repository state.
3. A branch/SHA inventory is recorded before deletion.
4. Pre-cleanup stale PRs are closed.
5. Old remote branches are removed; only `main` plus genuinely active short-lived work remains.
6. `.gitignore` covers the current Sideway runtime artifact pattern.
7. No runtime or trading mutation occurred during cleanup.
8. A second workflow-audit pass is ready, but workflow deletion is not mixed into the initial branch/PR cleanup.
