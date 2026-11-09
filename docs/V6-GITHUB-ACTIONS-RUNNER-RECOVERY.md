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

## Update after the new Windows runner registered (2026-11-09)

**The runner is now taking jobs.** Previous \`queued\` status was caused by no matching runner. The new Windows runner executed the jobs, then several FAILED because the runner **service environment** is not yet ready:

| Failing job | Diagnosed log error | Meaning |
| --- | --- | --- |
| Web Quality, LIVE ARM source contracts | \`pwsh: command not found\` | PowerShell 7 is not on the runner service's PATH |
| Canonical PR Gate, Private Master Core, API/Web dependency jobs | \`PSSecurityException\` on Actions-generated \`_temp/*.ps1\` | Script execution policy under service identity blocks GitHub Actions temporary scripts |
| Hosted Phase7C System Lifecycle | Missing \`.env.phase7b-live.example\`, plus lot test state leakage | Source tests needed inert template and isolated DEMO mode fixture |

**Code fixes:** the branch now restores the empty LIVE profile template with \`MT5_TRADING_ENABLED=false\`, and isolates the lot tests from tracked local runtime account state. Both changes preserve fail-closed LIVE posture.

**Safe service-account diagnosis on Windows (read-only, no MT5 access):**

\`\`\`powershell
Get-CimInstance Win32_Service -Filter "Name LIKE 'actions.runner.%'" |
  Select-Object Name,State,StartName,PathName
Get-Command pwsh -ErrorAction SilentlyContinue | Select-Object Source
Test-Path 'C:\Program Files\PowerShell\7\pwsh.exe'
Get-ExecutionPolicy -List
\`\`\`

**Resolution path:** on a *dedicated CI machine*, ensure PowerShell 7 is installed for all users and its directory is on the machine-level PATH visible to the runner service account; restart only the exact \`actions.runner.*\` Windows service after the administrator verifies it is safe. Review enterprise Group Policy versus PowerShell execution policy. Use a narrowly scoped, trusted CI execution policy instead of disabling Windows security globally, and do not run untrusted PR code on any machine with MT5 credentials/LIVE positions. Do not modify LIVE trading status to repair CI.

After environment repair, use the existing PR checks rather than arbitrary live deployment. Keep PR #1 as DRAFT until DEMO broker acceptance.
