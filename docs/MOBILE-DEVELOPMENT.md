# XAUUSD AI MASTER — Development from a phone

The practical mobile workflow is to keep GitHub as the code source-of-truth and use a browser-based development environment. The repository includes `.devcontainer/devcontainer.json` so GitHub Codespaces can create a repeatable Node.js 24 + Python 3.12 development environment with pnpm 10.18.0.

## Recommended workflow: GitHub Codespaces

From the GitHub repository in a phone browser, open **Code → Codespaces → Create codespace**. The devcontainer installs workspace dependencies after creation. Use the browser editor/terminal to inspect code, edit files, run source tests, build API/Web packages, commit, push, and open a pull request.

Typical development commands:

```bash
git status
git switch -c feat/my-change

node scripts/test-phase7c-web-mt5-sync-source.mjs
pnpm --filter @xauusd/api... build
pnpm --filter @xauusd/web... build

git add -A
git commit -m "feat: describe change"
git push -u origin feat/my-change
```

For very small edits, `github.dev` can also be used in a browser, but Codespaces is preferable when builds/tests or a terminal are required.

## Important boundary: phone/Codespaces is development, not MT5 execution

MetaTrader 5 execution, the local Python MT5 bridge, Windows Scheduled Tasks, terminal identity checks, LIVE ARM, and real broker mutation remain on a controlled Windows PC or Windows VPS. A Linux Codespace cannot replace that execution host.

Use the phone for code review, edits, builds, unit/source tests, PR/CI monitoring, documentation and non-broker development. Perform final MT5 integration/runtime verification on Windows.

## Ports and security

The devcontainer declares development ports 5717 (Web) and 3711 (Control API). Codespaces ports should remain **private**. Never expose the raw Phase7C Control API or MT5 bridge to the public Internet, and never put MT5/API credentials into repository files, Codespaces source control, screenshots, or PR comments.

The development API in Codespaces may not provide complete MT5-backed data because there is no Windows MT5 terminal there. This is expected; test broker/runtime integration on the Windows execution host.

## Mobile PR workflow

A safe flow is:

1. Create a feature branch in Codespaces.
2. Make one scoped change.
3. Run the relevant source tests and API/Web builds.
4. Push the branch and create a pull request.
5. Wait for required GitHub Actions checks.
6. Merge only after CI is green.
7. On the Windows execution PC, sync the integration branch and run the repository's guarded deploy/verification script.

For changes affecting trading logic, account mode, risk, LIVE execution, broker mutation, or runtime ownership, do not treat Codespaces-only tests as sufficient. Those changes require the project's existing safety gates and final Windows/DEMO validation.

## Optional future direction

If remote operational viewing from a phone is desired later, implement a separate authenticated read-only remote status channel or a private VPN/zero-trust path. Do not solve remote access by publicly forwarding localhost port 3711 or the MT5 bridge port.
