# M3 Self-Hosted Private CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish one canonical private Master/Core GitHub Actions gate that executes on a repository-level Windows self-hosted runner, proves real CI step execution without GitHub-hosted runner minutes, and preserves the broader M3 provenance/secret/regression acceptance contract.

**Architecture:** Keep one canonical workflow, `.github/workflows/private-master-core-ci.yml`, targeted to `[self-hosted, Windows, X64, xauusd-core-ci]`. Build the workflow contract-first: static RED test first, then minimal workflow to GREEN, then tracked-secret boundary, then live runner evidence. Distinguish `SELF_HOSTED_CI_INFRA=PASS` from `M3_PRIVATE_CI=GREEN`; the latter remains blocked until M2 bootstrap provenance is implemented and verified.

**Tech Stack:** Git/GitHub, GitHub Actions, Windows x64 self-hosted runner, Node.js 24, pnpm 10.18.0, Turbo, native `node:test`, PowerShell.

**Spec:** `docs/superpowers/specs/2026-09-16-m3-self-hosted-private-ci-design.md`

## Global Constraints

- Private repository is `thiennguyen3004931-sudo/xauusd-ai-master-core`.
- Implementation branch is `feat/m3-self-hosted-private-ci`.
- Runner scope is repository-level only.
- Required runner labels are exactly `self-hosted`, `Windows`, `X64`, `xauusd-core-ci`.
- Runner host must be a development workstation, not the production bot host.
- Runner directory must live outside every repository worktree.
- Runner must not store MT5 credentials, production deployment credentials, private signing keys, Telegram bot secrets, customer secrets, or production `.env` files.
- Workflow permissions remain `contents: read` only.
- Node.js version is exactly `24`.
- pnpm version is exactly `10.18.0`.
- Dependency install must use `pnpm install --frozen-lockfile`.
- Root `pnpm test` and root `pnpm lint` are not used as the initial M3 self-hosted acceptance gate because their unrelated baseline blockers are already separately proven; do not weaken, delete, or rewrite those tests in this plan.
- Existing PR #1 remains unmerged while M3 CI is not green.
- `PRODUCTION_MUTATION=NONE`.
- `BOT_RUNTIME_MUTATION=NONE`.
- `MODE_MUTATION=NONE`.
- `ARM_MUTATION=NONE`.
- `TASK_MUTATION=NONE`.
- `PROCESS_MUTATION=NONE`.
- `ORDER_MUTATION=NONE`.
- `POSITION_MUTATION=NONE`.
- `LIVE_TEST_ORDER=NONE`.

---

## File Structure

- `scripts/security/private-master-core-ci-contract.test.mjs` — static workflow contract. It fails if the canonical workflow is absent, targets GitHub-hosted runners, weakens permissions, omits required build/regression commands, or introduces forbidden production mutation/secret wiring.
- `scripts/security/check-private-secrets.mjs` — fail-closed tracked-path secret boundary for private repository source control.
- `scripts/security/check-private-secrets.test.mjs` — TDD coverage for tracked secret/key filename rejection and safe documentation/test fixture allowance.
- `.github/workflows/private-master-core-ci.yml` — the single canonical self-hosted M3 workflow.
- `docs/private/SELF-HOSTED-CI.md` — runner registration, label, service, verification, and removal procedure without recording any registration token.

---

### Task 1: Static self-hosted workflow contract — RED first

**Files:**
- Create: `scripts/security/private-master-core-ci-contract.test.mjs`
- Expected missing target: `.github/workflows/private-master-core-ci.yml`

**Interfaces:**
- Consumes workflow source text from `.github/workflows/private-master-core-ci.yml`.
- Produces deterministic node:test verdicts for runner labels, permissions, versions, commands, and forbidden content.

- [ ] **Step 1: Create the failing contract test**

Create `scripts/security/private-master-core-ci-contract.test.mjs` with:

```js
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const workflowPath = path.join(
  repoRoot,
  ".github/workflows/private-master-core-ci.yml",
);

function readWorkflow() {
  assert.equal(
    fs.existsSync(workflowPath),
    true,
    "private-master-core-ci.yml must exist",
  );
  return fs.readFileSync(workflowPath, "utf8");
}

test("private Master/Core CI targets only the dedicated self-hosted Windows runner", () => {
  const source = readWorkflow();

  assert.match(
    source,
    /runs-on:\s*\[\s*self-hosted\s*,\s*Windows\s*,\s*X64\s*,\s*xauusd-core-ci\s*\]/,
  );
  assert.doesNotMatch(source, /ubuntu-latest|windows-latest|macos-latest/);
  assert.match(source, /permissions:\s*\n\s*contents:\s*read/);
});

test("private Master/Core CI pins toolchain and runs the approved scoped gates", () => {
  const source = readWorkflow();

  assert.match(source, /node-version:\s*24/);
  assert.match(source, /version:\s*10\.18\.0/);
  assert.match(source, /pnpm install --frozen-lockfile/);
  assert.match(source, /pnpm build/);
  assert.match(
    source,
    /scripts\/test-phase7c-telegram-entry-resolution-lifecycle-contract\.mjs/,
  );
  assert.match(
    source,
    /scripts\/test-phase7c-telegram-lifecycle-observability-contract\.mjs/,
  );
  assert.match(source, /scripts\/phase7c-trade-notifier-synthetic\.test\.mjs/);
  assert.match(source, /scripts\/test-phase7c-hold-telegram-dedupe-contract\.mjs/);
  assert.match(source, /scripts\/security\/check-private-secrets\.mjs --tracked/);
  assert.match(source, /git diff --check/);
});

test("private Master/Core CI contains no production mutation or secret wiring", () => {
  const source = readWorkflow();

  for (const forbidden of [
    /ubuntu-latest/i,
    /windows-latest/i,
    /macos-latest/i,
    /mt5.*password/i,
    /telegram.*token/i,
    /signing.*private/i,
    /production.*credential/i,
    /live.*test.*order/i,
    /arm.*live/i,
    /schtasks\s+\/(?:create|change|delete|run)/i,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});
```

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test .\scripts\security\private-master-core-ci-contract.test.mjs
```

Expected: FAIL with `private-master-core-ci.yml must exist`.

- [ ] **Step 3: Commit the RED test only**

```powershell
git add -- scripts/security/private-master-core-ci-contract.test.mjs
git diff --cached --check
git commit -m "test: pin M3 self-hosted private CI contract"
```

---

### Task 2: Tracked-secret boundary — RED to GREEN

**Files:**
- Create: `scripts/security/check-private-secrets.test.mjs`
- Create: `scripts/security/check-private-secrets.mjs`

**Interfaces:**
- Exports `inspectTrackedPath(filePath): "ALLOW" | "REJECT"`.
- CLI: `node scripts/security/check-private-secrets.mjs --tracked`.
- CLI prints only rejected path names, never file contents or secret values.

- [ ] **Step 1: Write RED path-classification tests**

Create `scripts/security/check-private-secrets.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { inspectTrackedPath } from "./check-private-secrets.mjs";

test("tracked private-key and credential filenames are rejected", () => {
  for (const filePath of [
    "keys/master-signing.pem",
    "keys/device-private.key",
    "config/prod.env",
    ".env",
    ".env.production",
    "certs/customer.p12",
    "certs/customer.pfx",
    "ssh/id_rsa",
    "ssh/id_ed25519",
    "config/private-key.json",
    "config/signing-key.json",
    "config/customer-credential.json",
  ]) {
    assert.equal(inspectTrackedPath(filePath), "REJECT", filePath);
  }
});

test("safe documentation and explicit examples are allowed", () => {
  for (const filePath of [
    "docs/public/SECURITY-BOUNDARY.md",
    "docs/private/SELF-HOSTED-CI.md",
    "config/app.env.example",
    "scripts/security/check-private-secrets.test.mjs",
  ]) {
    assert.equal(inspectTrackedPath(filePath), "ALLOW", filePath);
  }
});
```

- [ ] **Step 2: Run RED**

```powershell
node --test .\scripts\security\check-private-secrets.test.mjs
```

Expected: FAIL because `check-private-secrets.mjs` does not exist.

- [ ] **Step 3: Implement minimal fail-closed tracked-path checker**

Create `scripts/security/check-private-secrets.mjs`:

```js
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function inspectTrackedPath(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  const lower = normalized.toLowerCase();

  if (/\.env\.example$/.test(lower) || /\.env\.sample$/.test(lower)) {
    return "ALLOW";
  }

  if (
    /(^|\/)\.env(?:\.|$)/.test(lower) ||
    /(^|\/)prod\.env$/.test(lower) ||
    /\.(?:pem|p12|pfx)$/.test(lower) ||
    /(^|\/)id_(?:rsa|ed25519)(?:\.|$)/.test(lower) ||
    /(^|\/)[^/]*(?:private-key|signing-key|credential)[^/]*$/.test(lower)
  ) {
    return "REJECT";
  }

  return "ALLOW";
}

function trackedPaths() {
  const stdout = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return stdout.split("\0").filter(Boolean);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--tracked") {
    console.error("USAGE: node scripts/security/check-private-secrets.mjs --tracked");
    process.exitCode = 2;
  } else {
    const rejected = trackedPaths().filter(
      (filePath) => inspectTrackedPath(filePath) === "REJECT",
    );

    for (const filePath of rejected) {
      console.error(`TRACKED_SECRET_PATH_REJECTED:${filePath}`);
    }

    if (rejected.length > 0) {
      process.exitCode = 1;
    } else {
      console.log("TRACKED_SECRET_PATHS=PASS");
    }
  }
}
```

- [ ] **Step 4: Run GREEN**

```powershell
node --test .\scripts\security\check-private-secrets.test.mjs
node .\scripts\security\check-private-secrets.mjs --tracked
```

Expected: tests PASS and `TRACKED_SECRET_PATHS=PASS`. If real tracked secret-looking paths are found, stop; inspect and remediate without printing contents.

- [ ] **Step 5: Commit secret boundary**

```powershell
git add -- scripts/security/check-private-secrets.mjs scripts/security/check-private-secrets.test.mjs
git diff --cached --check
git commit -m "security: gate tracked private credential paths"
```

---

### Task 3: Canonical self-hosted workflow — GREEN the static contract

**Files:**
- Create: `.github/workflows/private-master-core-ci.yml`
- Test: `scripts/security/private-master-core-ci-contract.test.mjs`

**Interfaces:**
- Runs only on the dedicated self-hosted labels.
- Emits `SELF_HOSTED_CI_INFRA=PASS` only after real runner steps execute.
- Emits `M3_PROVENANCE=BLOCKED_M2_NOT_IMPLEMENTED` when bootstrap provenance files are absent; this must not be treated as `M3_PRIVATE_CI=GREEN`.

- [ ] **Step 1: Add minimal canonical workflow**

Create `.github/workflows/private-master-core-ci.yml`:

```yaml
name: Private Master Core Self-Hosted CI

on:
  pull_request:
    branches:
      - main
  push:
    branches:
      - feat/m3-self-hosted-private-ci
  workflow_dispatch:

permissions:
  contents: read

jobs:
  private-master-core:
    name: private-master-core-self-hosted
    runs-on: [self-hosted, Windows, X64, xauusd-core-ci]
    timeout-minutes: 45

    steps:
      - name: Checkout exact head
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Runner identity
        shell: pwsh
        run: |
          Write-Host "RUNNER_OS=$env:RUNNER_OS"
          Write-Host "RUNNER_ARCH=$env:RUNNER_ARCH"
          Write-Host "GITHUB_SHA=$env:GITHUB_SHA"

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10.18.0
          run_install: false

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm

      - name: Install locked dependencies
        run: pnpm install --frozen-lockfile

      - name: Static private CI contract
        run: node --test scripts/security/private-master-core-ci-contract.test.mjs

      - name: Tracked-secret boundary tests
        run: node --test scripts/security/check-private-secrets.test.mjs

      - name: Tracked-secret boundary
        run: node scripts/security/check-private-secrets.mjs --tracked

      - name: Build workspace
        run: pnpm build

      - name: Phase7C entry resolution contract
        run: node --test scripts/test-phase7c-telegram-entry-resolution-lifecycle-contract.mjs

      - name: Telegram lifecycle regression
        run: >-
          node --test
          scripts/test-phase7c-telegram-lifecycle-observability-contract.mjs
          scripts/phase7c-trade-notifier-synthetic.test.mjs
          scripts/test-phase7c-hold-telegram-dedupe-contract.mjs

      - name: M2 provenance status
        shell: pwsh
        run: |
          if ((Test-Path "scripts/security/verify-private-bootstrap.mjs") -and
              (Test-Path "security/private-bootstrap-attestation.json")) {
            node scripts/security/verify-private-bootstrap.mjs security/private-bootstrap-attestation.json
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            Write-Host "M3_PROVENANCE=PASS"
          } else {
            Write-Host "M3_PROVENANCE=BLOCKED_M2_NOT_IMPLEMENTED"
          }

      - name: Diff hygiene
        run: git diff --check

      - name: Tracked worktree cleanliness
        shell: pwsh
        run: |
          $status = git status --porcelain --untracked-files=no
          if ($status) {
            Write-Error "TRACKED_WORKTREE_DIRTY"
            Write-Host $status
            exit 1
          }
          Write-Host "TRACKED_WORKTREE_CLEAN=TRUE"

      - name: Self-hosted CI infrastructure verdict
        shell: pwsh
        run: Write-Host "SELF_HOSTED_CI_INFRA=PASS"
```

- [ ] **Step 2: Run static contract GREEN locally**

```powershell
node --test .\scripts\security\private-master-core-ci-contract.test.mjs
node --test .\scripts\security\check-private-secrets.test.mjs
node .\scripts\security\check-private-secrets.mjs --tracked
git diff --check
```

Expected: all PASS.

- [ ] **Step 3: Commit workflow**

```powershell
git add -- .github/workflows/private-master-core-ci.yml
git diff --cached --check
git commit -m "ci: add canonical self-hosted private core gate"
```

---

### Task 4: Runner operating procedure

**Files:**
- Create: `docs/private/SELF-HOSTED-CI.md`

**Interfaces:**
- Documents setup only; contains no token, secret, machine-specific credential, or production path.
- Requires runner label `xauusd-core-ci` and repository scope `thiennguyen3004931-sudo/xauusd-ai-master-core`.

- [ ] **Step 1: Write the runner procedure**

Document these exact controls:

```text
Repository: thiennguyen3004931-sudo/xauusd-ai-master-core
Runner scope: repository-level
OS: Windows x64
Custom label: xauusd-core-ci
Runner directory: outside repository worktrees
First verification mode: interactive
Service mode: only after first successful workflow run
Production credentials on runner: forbidden
Registration token in docs/logs/Git: forbidden
```

Use GitHub UI path:

```text
Repository -> Settings -> Actions -> Runners -> New self-hosted runner
```

For the commands displayed by GitHub, copy them directly into an elevated or normal PowerShell session as appropriate. Do not paste the registration token into chat, issue comments, source files, screenshots, or commit messages.

After configuration, add the custom label `xauusd-core-ci` in the runner configuration/UI and start interactively with the GitHub-provided `run.cmd` command.

Removal procedure must require GitHub deregistration first, then service stop/removal if installed, then local runner directory deletion.

- [ ] **Step 2: Verify documentation contains no token-like value**

```powershell
git diff --check
Select-String -Path .\docs\private\SELF-HOSTED-CI.md -Pattern "A[A-Z0-9]{20,}|ghp_|github_pat_|token=" -CaseSensitive:$false
```

Expected: no token-like match.

- [ ] **Step 3: Commit documentation**

```powershell
git add -- docs/private/SELF-HOSTED-CI.md
git diff --cached --check
git commit -m "docs: document private self-hosted CI runner"
```

---

### Task 5: Branch-local verification before runner registration

**Files:**
- No new files.

**Interfaces:**
- Produces source-level evidence before any runner registration mutation.

- [ ] **Step 1: Run M3 static/security gates**

```powershell
node --test .\scripts\security\private-master-core-ci-contract.test.mjs
node --test .\scripts\security\check-private-secrets.test.mjs
node .\scripts\security\check-private-secrets.mjs --tracked
```

Expected: PASS.

- [ ] **Step 2: Run accepted scoped regressions**

```powershell
node --test .\scripts\test-phase7c-telegram-entry-resolution-lifecycle-contract.mjs
node --test `
  .\scripts\test-phase7c-telegram-lifecycle-observability-contract.mjs `
  .\scripts\phase7c-trade-notifier-synthetic.test.mjs `
  .\scripts\test-phase7c-hold-telegram-dedupe-contract.mjs
pnpm build
```

Expected:

```text
Phase7C targeted: 6/6 PASS
Telegram regression: 19/19 PASS
Build: 16/16 PASS
```

- [ ] **Step 3: Final source hygiene**

```powershell
git diff --check
git status --short
git log -8 --oneline
```

Expected: clean worktree after commits.

- [ ] **Step 4: Push branch and open a draft PR**

```powershell
git push private feat/m3-self-hosted-private-ci
```

Open a draft PR against private `main` with explicit safety block:

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

Do not mark ready for review yet.

---

### Task 6: Register and prove the self-hosted runner

**Files:**
- No source changes required for registration.

**Interfaces:**
- GitHub repository runner becomes `ONLINE` and carries label `xauusd-core-ci`.
- First workflow run must show non-empty step execution on exact head SHA.

- [ ] **Step 1: Register repository-level runner from GitHub-generated commands**

Navigate to:

```text
xauusd-ai-master-core -> Settings -> Actions -> Runners -> New self-hosted runner
```

Choose `Windows` / `x64`. Run only the commands GitHub displays. Do not save or paste the registration token anywhere outside the interactive setup command.

Configure:

```text
runner name: XAUUSD-CORE-CI-WIN
custom label: xauusd-core-ci
work folder: _work
```

- [ ] **Step 2: Start runner interactively**

Use the GitHub-generated `run.cmd` from the runner directory. Keep the console open for the first verification run.

Expected GitHub UI status: `Idle` / `Online`.

- [ ] **Step 3: Trigger exact-head verification**

Use the draft PR trigger, branch push, or `workflow_dispatch` on the exact implementation head. Record only:

```text
HEAD_SHA=<exact commit>
RUN_ID=<GitHub Actions run id>
RUNNER_NAME=XAUUSD-CORE-CI-WIN
RUNNER_LABEL=xauusd-core-ci
```

Do not record registration tokens or environment secrets.

- [ ] **Step 4: Require actual executed steps**

Acceptance requires:

```text
steps != []
checkout executed
Node setup executed
pnpm setup executed
frozen install executed
build executed
Phase7C targeted executed
Telegram regression executed
tracked-secret gate executed
git diff --check executed
SELF_HOSTED_CI_INFRA=PASS
```

A queued job, offline runner, label mismatch, immediate failure before steps, or `steps=[]` is a failure.

- [ ] **Step 5: Only after the first successful interactive run, optionally install as a Windows service**

Use only the service commands documented by the downloaded GitHub runner package. Re-run the same workflow after service installation and require the same executed-step evidence.

---

### Task 7: M3 verdict and provenance gate

**Files:**
- No source changes unless M2 provenance is implemented separately under its existing approved plan.

**Interfaces:**
- Produces truthful final status; never maps runner success directly to M3 green.

- [ ] **Step 1: Evaluate runner infrastructure verdict**

Set:

```text
SELF_HOSTED_CI_INFRA=PASS
```

only when Task 6 has a successful exact-head run with real executed steps.

- [ ] **Step 2: Evaluate broader M3 prerequisites**

Require all of:

```text
M2_PRIVATE_BOOTSTRAP_ATTESTATION=PASS
TRACKED_SECRET_BOUNDARY=PASS
BUILD=PASS
PHASE7C_TARGETED=PASS
TELEGRAM_REGRESSION=PASS
DIFF_HYGIENE=PASS
TRACKED_WORKTREE_CLEAN=TRUE
SELF_HOSTED_CI_INFRA=PASS
```

If M2 attestation remains absent, report:

```text
SELF_HOSTED_CI_INFRA=PASS
M3_PRIVATE_CI=BLOCKED_M2_PROVENANCE
```

Do not mark M3 green.

- [ ] **Step 3: Keep PR #1 and the M3 PR unmerged until relevant acceptance is green**

No merge, no M4 public sanitization, and no production rollout is authorized by partial M3 evidence.

---

## Self-Review

- Spec coverage: runner scope, labels, Windows x64 host, canonical workflow, static contract, tracked-secret boundary, toolchain pinning, frozen install, build, Phase7C 6/6, Telegram 19/19, diff hygiene, documentation, runner live evidence, rollback/removal, and production safety are all mapped to tasks.
- M2 dependency is explicit: runner execution can prove `SELF_HOSTED_CI_INFRA=PASS`, but missing provenance keeps `M3_PRIVATE_CI` blocked.
- No placeholder/TODO steps remain.
- No task requires production secrets, MT5 access, bot runtime mutation, ARM/mode changes, scheduled task changes, orders, positions, or LIVE test orders.
- Workflow scope remains one canonical M3 workflow; existing legacy workflows are not mass-migrated in this plan.
