# XAUUSD Master/Core Private Self-Hosted CI Runner

## Scope and safety boundary

This runner is dedicated to the private repository `thiennguyen3004931-sudo/xauusd-ai-master-core`.

- Runner scope: repository-level only.
- OS/architecture: Windows x64.
- Required custom label: `xauusd-core-ci`.
- Runner name: `XAUUSD-CORE-CI-WIN`.
- Runner directory: outside every repository worktree.
- First verification mode: interactive.
- Service mode: only after the first successful workflow run.
- Production credentials on runner: forbidden.
- MT5 credentials on runner: forbidden.
- Telegram bot secrets on runner: forbidden.
- Customer secrets on runner: forbidden.
- Private signing keys on runner: forbidden.
- Production `.env` files on runner: forbidden.
- Registration token in documentation, logs, Git history, screenshots, chat, issue comments, or commit messages: forbidden.

The runner is CI infrastructure only. It must not be the production bot host and must not be used to mutate production bot runtime, mode, ARM state, scheduled tasks, processes, orders, positions, or LIVE test orders.

## Registration

In GitHub, open:

`Repository -> Settings -> Actions -> Runners -> New self-hosted runner`

Choose `Windows` and `x64`.

Use only the commands GitHub generates on that page. Run them directly in the PowerShell session on the dedicated development workstation. Do not copy the registration credential into source files, documentation, screenshots, chat, issue comments, or commit messages.

Configure the runner with these values:

```text
runner name: XAUUSD-CORE-CI-WIN
custom label: xauusd-core-ci
work folder: _work
```

Keep the runner installation directory outside all repository worktrees.

## First verification run

Start the runner interactively using the `run.cmd` command supplied with the GitHub runner package. Keep that console open during the first workflow run.

GitHub should show the runner as Online/Idle and show the labels:

```text
self-hosted
Windows
X64
xauusd-core-ci
```

Trigger `.github/workflows/private-master-core-ci.yml` for the exact implementation branch/head.

Record only non-secret evidence:

```text
HEAD_SHA=<exact commit>
RUN_ID=<GitHub Actions run id>
RUNNER_NAME=XAUUSD-CORE-CI-WIN
RUNNER_LABEL=xauusd-core-ci
```

Acceptance requires actual executed steps, including checkout, Node setup, pnpm setup, frozen install, static workflow contract, tracked-secret tests and scan, private-bootstrap provenance tests and verifier, build, scoped Phase7C tests, Telegram regressions, broader private regression evidence, `git diff --check`, tracked-worktree cleanliness, and the final verdict steps.

A queued job, offline runner, label mismatch, immediate failure before steps, or empty step execution does not prove infrastructure PASS.

`SELF_HOSTED_CI_INFRA=PASS` is not equivalent to `M3_PRIVATE_CI=GREEN`.

The branch contains the M2 bootstrap attestation/verifier. The self-hosted run must execute those checks successfully before M2 provenance counts as runtime CI evidence. Full M3 acceptance also requires the broader private regression to pass. The workflow therefore reports the outcomes separately:

```text
SELF_HOSTED_CI_INFRA=PASS
M3_PRIVATE_CI=BLOCKED_M2_PROVENANCE
M3_PRIVATE_CI=BLOCKED_BROADER_REGRESSION
M3_PRIVATE_CI=GREEN
```

Only one `M3_PRIVATE_CI` verdict is emitted by a completed run. Infrastructure PASS may coexist with a blocked full-M3 verdict; this is intentional and prevents runner availability from being mistaken for full repository acceptance.

## Service mode

Only after the first successful interactive workflow run may the runner be installed as a Windows service.

Use only the service commands documented by the downloaded GitHub runner package. After service installation, rerun the same exact-head workflow and require the same executed-step evidence.

## Removal

Remove the runner in this order:

1. Deregister/remove the runner from the repository in GitHub.
2. If a Windows service was installed, stop and remove that service using the runner package's documented service commands.
3. Delete the local runner directory.
4. Confirm the repository no longer lists the runner.

Never preserve registration credentials as part of removal evidence.

## Production invariants

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
