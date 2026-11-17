# Main-branch governance — private Core on GitHub Free

Observation on 2026-10-25: the private Core `main` branch returns `protected=false`. Do **not** claim server-side approval or required-status-check enforcement.

GitHub's official branch-protection and ruleset documentation currently limits enforcement for **private repositories** to eligible paid plans (e.g. Pro, Team, Enterprise); GitHub Free supports public repository protections. Making this proprietary Core public to get a free branch rule is **not acceptable** because it contains private trading IP. See:
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets

## Temporary mandatory operator process (procedural, not GitHub-enforced)

1. Do not push directly to private Core `main`; create `feat/`, `fix/`, `hardening/` branches and pull requests.
2. Require a recorded independent review for strategy, security, MT5, risk, customer release and monitoring changes; do not self-approve as a substitute for an independent reviewer.
3. Before merge, require `Private Master Core Self-Hosted CI`, `Phase7C Canonical PR Gate`, and each affected scoped workflow on the **final PR HEAD**. Red/cancelled/queued checks block merge by process. Revalidate after amendments.
4. Record head SHA, branch, PR, check URLs, approval identity, operator decision, rollback path and release impact. No force pushes to main; no deletion of main.
5. Production remains separate: source merge or package acceptance does not grant approval to change bot mode, account, ARM, MT5 or orders.
6. Recheck branch protection state after every governance change, and escalate if it is still `false`.

## Upgrade path — hardware-enforced rules

Keep Core private. When an eligible plan and repository admin capability are available, configure protection/rules for `main`: PR required, independent approval, latest-head required checks, conversation resolution, forbid force push and deletion, and prevent bypasses where supported. Validate enforcement with a harmless temporary PR and record screenshot/API evidence; do not declare complete until `protected=true` (or active applicable rulesets independently verified).

**Current blocker:** plan entitlement and the available GitHub integration do not expose branch-protection/ruleset writes. Therefore no branch policy has been activated through this work.

## Proposed checks to require

- `private-master-core-self-hosted` (Private Master Core)
- `Phase7C Canonical PR Gate` job (inspect exact check context before configuring)
- `Customer Handoff Final Production Acceptance Read-Only` when customer access/release contracts change
- `Customer Deployment + Follower Execution Acceptance Read-Only` when packages or follower execution change
- `AUTO LIVE Read-Only Event Monitor` static contract on monitor changes

Avoid selecting stale/ambiguous check names; confirm successful check contexts on recent PRs.
