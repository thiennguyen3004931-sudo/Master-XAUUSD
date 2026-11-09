# XAUUSD AI MASTER

Integrated pnpm/Turbo monorepo for the XAUUSD AI trading stack on MT5.

## Active architecture

```text
apps/web      Vite + React dashboard / control center
apps/api      Express orchestration and read-only observability API
packages/*    strategy, risk and MT5 broker packages
mt5/          read-only MT5 decision panel source
scripts/      guarded local deployment / account / verification tooling
```

Phase7C supports isolated DEMO and LIVE MT5 profiles. Account selection, LIVE ARM and bot mode are separate safety operations. The Web account-switch flow is guarded and must finish a switch to LIVE as `LIVE + PAUSE + DISARMED`; it does not ARM LIVE. The MT5 decision panel is read-only with `ORDER PERMISSION = NONE`.

## Current operator documentation

- [Web + MT5 synchronized dashboard and DEMO E2E](PHASE7C-WEB-MT5-SYNC-DEMO-E2E.md)
- [Portable deployment to another Windows PC](docs/PORTABLE-DEPLOYMENT.md)
- [Customer handoff and operations guide](customer-release/README.md)
- [Development from a phone with GitHub Codespaces](docs/MOBILE-DEVELOPMENT.md)

## Portable source package

Create a source-only ZIP from a clean Git commit:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\package-phase7c-portable-release.ps1 `
  -RequiredCommit <MERGED_COMMIT_SHA>
```

The ZIP intentionally excludes local `.env` profiles, `.runtime`, credentials, MT5 data directories, databases, logs, dependency folders and LIVE arm state. GitHub Actions also publishes a 30-day portable source artifact for the portable-deploy workflow.

On a new Windows PC, begin with the fail-closed prerequisite check:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\bootstrap-phase7c-new-pc.ps1
```

Installation/build/config actions require explicit flags. Bootstrap never performs an account switch, LIVE ARM or order send.

## Phone development

The repository includes `.devcontainer/devcontainer.json` for a browser-based GitHub Codespaces workspace using Node.js 24, pnpm 10.18.0 and Python 3.12. Use Codespaces on a phone for editing, source tests, builds, commits, PRs and CI review. Actual MT5 execution and final broker/runtime verification remain on a controlled Windows PC or Windows VPS.

Never make the raw Control API or MT5 bridge publicly reachable just to access the project from a phone.

## Local development

```powershell
pnpm install --frozen-lockfile
pnpm --filter @xauusd/api... build
pnpm --filter @xauusd/web... build
```

Use the Phase7C guarded scripts for runtime deployment rather than treating the generic monorepo development commands as a trading activation path.

## Safety boundary

- Machine-local MT5 secrets stay in gitignored `.env` files.
- `.runtime` and generated release artifacts are not committed.
- DEMO/LIVE account switching is guarded and separate from LIVE ARM.
- LIVE ARM is explicit, session-bound and fail-closed.
- MT5 panel/Web observability do not send broker orders.
- Portable packaging and new-PC bootstrap do not ARM LIVE, switch accounts, or send orders.
- Strategy/risk changes require their existing source tests, CI and DEMO validation before LIVE use.
