# GitHub Actions V6: queued self-hosted runner recovery (read-only guide)

**Scope:** PR #1 (\`fix/v6-entry-structural-sl-trailing-20261109\`) on \`thiennguyen3004931-sudo/Master-XAUUSD\`. This guide **does not** authorize LIVE trading or run a deployment.

## Diagnosis on 2026-11-09

GitHub Actions is **not globally disabled**. \`V6 trade entry and stops - offline safety\` passed on both GitHub-hosted Ubuntu and Windows (without an MT5 terminal). The Web safe-deploy and Phase7C SEMI-management CI also passed on the PR.

Jobs named \`canonical-pr-linux\`, \`canonical-pr-windows\`, \`private-master-core-self-hosted\`, \`web-quality\`, \`source-contract-windows\`, and the scheduled \`auto-live-readonly-monitor\` were **queued**. These workflows all declare \`runs-on: [self-hosted, Windows, X64, xauusd-core-ci]\` even where a job name includes "linux". No hosted runner may take the job because that label set is mandatory.

This is **consistent with** the required Windows runner being offline, busy, disabled, or lacking the \`xauusd-core-ci\` label. The GitHub connector does not provide a live runner-status/control action, so distinguish these possibilities in GitHub Settings before troubleshooting.

Repeated commits to the PR caused previous workflow runs to show \`cancelled\` due to per-workflow \`concurrency.cancel-in-progress: true\`. This is expected GitHub behavior, not evidence that Actions are disabled.

Separately, \`Phase7C System Lifecycle Broker CI\` failed on existing Phase7C checks; some observed failures include a missing \`packages/mt5-broker/bridge/.env.phase7b-live.example\` required by \`scripts/test-phase7c-live-arm-source.ps1\`, and two lot-settings assertions. They are **not** V6 offline unit-test failures. Do not remove or bypass Phase7C security/release gates to make PR #1 appear green.

## Restore the runner on its real Windows machine

1. In the GitHub repository, open **Settings → Actions → Runners**. Locate the runner configured with \`self-hosted\`, \`Windows\`, \`X64\`, \`xauusd-core-ci\`. Check **Online/Offline** and **Idle/Active**; check its configured labels.
2. On the Windows computer where the runner is installed, **do not stop the MT5 terminal or a live trading service**. Run the read-only diagnostic:
   \`\`\`powershell
   pwsh -NoProfile -File .\scripts\ops\check-v6-actions-runner-readonly.ps1
   \`\`\`
   Optionally include \`-CheckNetwork\` to test outbound HTTPS to GitHub port 443.
3. If a Windows service named \`actions.runner.*\` exists but is stopped, have the authorized computer administrator verify its identity and whether this host is safe to resume CI work. Start that **specific service** from Windows Services, or use \`Start-Service -Name '<exact service name>'\` with appropriate privilege. If it was installed in interactive mode, run \`run.cmd\` from its existing GitHub runner installation directory in the correct user session.
4. If the runner is online but queued jobs remain, check label compatibility and organization/repository runner-group access; inspect \`_diag\` logs in the runner installation directory and the workflow job queue. Never print runner registration tokens or repository secrets into logs.
5. Once the matching runner reports **Online/Idle**, use **Actions → workflow → failed/queued run → Re-run jobs**, or re-run the exact checks on PR #1. Avoid repeatedly pushing commits just to unstick a queued job; each commit cancels previous runs.

## V6 verification without a self-hosted runner

The PR has a GitHub-hosted \`V6 trade entry and stops - offline safety\` workflow containing:
- Ubuntu \`v6-offline\`: \`py_compile\`, pure entry/SL/trailing rules and mock-MT5 broker tests, Node syntax.
- Windows \`V6 Windows no-terminal safety\`: the same tests on \`windows-latest\`, without a live terminal.

These checks are **synthetic only**. They do not replace the real Windows MT5 **DEMO** end-to-end acceptance required before merging/releasing an automated trading bot.

## Release boundary

- Keep the PR in **Draft**; do not merge to \`main\` until code review, all required gate checks, DEMO execution and out-of-sample replay.
- Do not turn off security workflows, disable branch protection, or substitute hosted runners for jobs intentionally dependent on the production self-hosted broker machine.
- The V6 order path continues to reject unapproved REAL execution. A running Actions runner does **not** imply trading authorization.
