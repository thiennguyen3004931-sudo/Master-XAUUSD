# V6 isolated source-only release — NOT LIVE authorization

This package contains **only allowlisted, Git-tracked V6 source files** from one verified Git commit, plus a deterministic manifest containing each file's SHA-256. It is **not** a deployed, running or broker-verified trading bot. It never grants REAL trading rights.

## Included

- Standalone Node HTTP server, input guards, and standalone Web HTML.
- Python direct MT5 probe/engine, pure trade rules, and fail-closed UTC daily new-order loss veto.
- This operator guide and the non-invasive PowerShell stage integrity checker.
- `V6-ISOLATED-RELEASE-MANIFEST.json`, recording the Git HEAD SHA and hashes.

The bundle excludes `.runtime`, passwords, Telegram/API tokens, broker session files, old Phase7C bridge files, services/tasks, installed dependencies, MT5 terminal binaries, `.env`, source Git history, and any LIVE ARM file.

## Build (developer / trusted CI only)

From a clean Git repository checkout of the **intended, reviewed commit**:

```powershell
python scripts/ops/build-v6-isolated-source-release.py
```

The builder checks that each included file's bytes exactly match its version at Git `HEAD` and refuses symlinks, missing files or changed files. It also checks the source's REAL permission is still disabled, loopback-only listeners remain, the daily loss guard is wired, and no old Phase7C bridge writer or Cloudflare auto-tunnel remains. Output is `artifacts/v6-isolated-source-only.zip` (ignored by Git); it refuses overwriting an existing archive.

GitHub's `V6 Isolated Source Package (NO DEPLOY)` workflow runs on **GitHub-hosted Windows**. Only a successful workflow on trusted `main` uploads the source ZIP as a GitHub Actions artifact. A PR runs the tests but does not publish an artifact.

## Check a separate Windows stage — no MT5 access

The `V6 Windows isolated source staging (NO START)` workflow can prepare this
source-only copy on the registered Windows runner. Only trusted `main` can run
the host job; pull requests exercise the disposable hosted build only. It uses
a fresh, non-overwritten directory under `RUNNER_TEMP`, verifies the manifest
against the exact workflow commit and runs the source checker. It never checks
out or cleans the operating repository, starts V6/MT5, installs dependencies,
reads credentials, switches accounts or enables REAL permission. A successful
run proves staged source only; temporary storage may later be cleaned by the
runner and is not the final production installation.

On the intended machine, choose a **new, empty, independent directory** whose path is not inside the existing Phase7C/production directory. Back up any existing local `.runtime` separately before altering an installed checkout. Extract the ZIP *only* into that new directory; do **not** extract over the operating Phase7C tree or over any account configuration.

Run from the extracted root in PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\ops\check-v6-isolated-stage-readonly.ps1
```

The checker compares exactly eight allowlisted file hashes, rejects a `.runtime` directory or legacy bridge markers, reports only whether Node/Python executables can be found and whether local API/Web ports appear available. It does not open files containing credentials, install packages, launch processes, log into MT5, send orders, change account modes, or use the network. A source-integrity PASS means **only that extraction matches the source bundle**. It does not mean Node/Python packages are compatible, the MT5 broker is reachable or the trading system is running.

### Remaining separate human-controlled gates

1. Confirm a dedicated Windows location and verify the ZIP commit matches approved GitHub `main`.
2. Provision Node and an **approved** Python + MetaTrader5 package manually without letting bot code invoke pip; verify terminal/account bindings in an explicitly authorized read-only validation.
3. Ensure the API/Web ports do not collide with Phase7C, and keep both endpoints bound to `127.0.0.1`. Remote tunnel is disabled in V6.
4. Independently verify stop-loss controls, order/partial-fill/restart reconciliation, overnight equity/day loss tracking and a real emergency stop against the broker. Rotate exposed Telegram credentials outside GitHub.
5. Keep Python `live_permission = False`. Turning it off would be a *different*, reviewed and explicitly authorized change after complete operational acceptance.

**Do not run the standalone server merely because this ZIP passes tests.** No service registration, Windows Scheduled Task, deployment, account switch, broker order or LIVE activation is performed by the packaging workflow or the stage checker.
