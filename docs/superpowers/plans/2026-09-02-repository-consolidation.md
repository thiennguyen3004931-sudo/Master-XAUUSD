# Repository Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce XAUUSD AI MASTER to one canonical production truth (`main`) by archiving all current refs, closing stale PR scopes, deleting stale remote branches, and fixing runtime-artifact Git hygiene without mutating LIVE trading runtime.

**Architecture:** Destructive cleanup is gated by a verified external Git bundle plus a committed branch/SHA manifest. Stale PRs are closed without merge, stale remote refs are deleted from the manifest rather than branch-name guesses, and one source-only consolidation PR carries the audit trail plus `.gitignore` correction. Workflow consolidation and `main` protection/ruleset hardening are deliberately deferred to a second plan because required status checks must be mapped before branch protection is changed.

**Tech Stack:** Git, GitHub, PowerShell, Markdown.

**Spec:** `docs/superpowers/specs/2026-09-02-repository-consolidation-design.md`

## Global Constraints

- Canonical repo: `thiennguyen3004931-sudo/xauusd-ai-master`.
- Canonical branch at cleanup start: `main`.
- Canonical SHA at cleanup start: `69ed572fc0232fae228534d5cf7f73e0b2b282db`.
- Never rewrite `main` history.
- No remote branch deletion until archive bundle verification and branch manifest verification both PASS.
- Close stale PRs without merge.
- Do not delete workflows in this plan.
- Defer `main` protection/ruleset mutation to the workflow/governance plan after required CI checks are canonicalized.
- Add `/scripts/.phase7c-sideway-runtime-*.mjs` to repository `.gitignore`.
- `ORDER_MUTATION=NONE`, `LIVE_TEST_ORDER=NONE`, `MODE_CHANGE=NONE`, `ARM_CHANGE=NONE`, `BRIDGE_RESTART=NONE`, `EXECUTOR_RESTART=NONE`, `WEB_API_RESTART=NONE`, `RUNTIME_DEPLOYMENT=NONE`.

---

### Task 1: Create and verify the pre-cleanup archive

**Files:**
- External: `F:\Project\XAUUSD_AI_MASTER\archive\xauusd-ai-master-pre-cleanup-20260902.bundle`
- Create: `docs/repository-cleanup/pre-cleanup-branches-20260902.tsv`

**Interfaces:**
- Consumes: local clone and `origin`.
- Produces: verified full-ref archive and exact deletion inventory.

- [ ] **Step 1: Lock the local checkout to the approved production SHA**

```powershell
cd F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master
$expected = '69ed572fc0232fae228534d5cf7f73e0b2b282db'
git switch main
git fetch origin --prune --tags
$actual = (git rev-parse HEAD).Trim()
if ($actual -ne $expected) { throw "STOP: expected=$expected actual=$actual" }
```

Expected: exact SHA match.

- [ ] **Step 2: Create and verify the full bundle**

```powershell
$archiveDir = 'F:\Project\XAUUSD_AI_MASTER\archive'
New-Item -ItemType Directory -Force -Path $archiveDir | Out-Null
$bundle = Join-Path $archiveDir 'xauusd-ai-master-pre-cleanup-20260902.bundle'
git bundle create $bundle --all
if ($LASTEXITCODE -ne 0) { throw 'STOP: bundle create failed' }
git bundle verify $bundle
if ($LASTEXITCODE -ne 0) { throw 'STOP: bundle verify failed' }
```

Expected: bundle verification PASS.

- [ ] **Step 3: Generate the remote branch/SHA manifest**

```powershell
$manifestDir = 'docs\repository-cleanup'
New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null
$manifest = Join-Path $manifestDir 'pre-cleanup-branches-20260902.tsv'
@("branch`tsha") | Set-Content -LiteralPath $manifest -Encoding utf8
git ls-remote --heads origin | ForEach-Object {
  $p = $_ -split '\s+'
  "$($p[1] -replace '^refs/heads/','')`t$($p[0])"
} | Sort-Object | Add-Content -LiteralPath $manifest -Encoding utf8
```

Expected: one row for every remote head.

- [ ] **Step 4: Enforce the archive gate**

```powershell
$rows = @(Get-Content -LiteralPath $manifest | Select-Object -Skip 1)
if (-not (Test-Path $bundle -PathType Leaf)) { throw 'STOP: bundle missing' }
if ($rows.Count -lt 200) { throw "STOP: suspicious branch count=$($rows.Count)" }
if (-not ($rows -contains "main`t$expected")) { throw 'STOP: canonical main missing from manifest' }
Write-Host 'ARCHIVE_GATE=PASS'
Write-Host "MANIFEST_BRANCH_COUNT=$($rows.Count)"
```

Expected: `ARCHIVE_GATE=PASS`. No deletion may occur before this marker.

---

### Task 2: Close the nine stale pre-cleanup PRs

**Files:** none.

**Interfaces:**
- Consumes: Task 1 archive gate.
- Produces: no stale PR presented as an active scope.

- [ ] **Step 1: Re-read open PRs and require the known pre-cleanup set**

Known stale PRs: `1, 2, 3, 94, 98, 121, 178, 217, 225`.

Abort if a newly created unknown PR is present; classify it before continuing.

- [ ] **Step 2: Add this exact note to each stale PR**

```text
Repository consolidation: this PR is a historical/superseded scope and is no longer an active production source. Canonical production work continues from current main. The PR is being closed without merge; commit/PR history remains available for audit and recovery.
```

- [ ] **Step 3: Close all nine PRs without merge**

Expected per PR: `state=closed`, `merged=false`.

- [ ] **Step 4: Verify stale pre-cleanup open PR count is zero**

Expected: `STALE_PRE_CLEANUP_PRS=0`.

---

### Task 3: Canonicalize Sideway runtime-artifact ignore behavior

**Files:**
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Sideway wrapper runtime naming convention.
- Produces: generated `.phase7c-sideway-runtime-<PID>.mjs` files no longer dirty Git worktrees.

- [ ] **Step 1: Prove RED on the original tree**

```powershell
git check-ignore -q scripts/.phase7c-sideway-runtime-12345.mjs
if ($LASTEXITCODE -eq 0) { throw 'RED NOT PROVEN: file is already ignored' }
Write-Host 'RUNTIME_ARTIFACT_IGNORE_RED=PASS'
```

- [ ] **Step 2: Add the exact rule under the Phase7B/Phase7C runtime-artifact block**

```gitignore
/scripts/.phase7c-sideway-runtime-*.mjs
```

Keep the existing `/scripts/.phase7c-sideway-live-runtime-*.mjs` line.

- [ ] **Step 3: Prove GREEN**

```powershell
git check-ignore -v scripts/.phase7c-sideway-runtime-12345.mjs
if ($LASTEXITCODE -ne 0) { throw 'STOP: runtime artifact not ignored' }
Write-Host 'RUNTIME_ARTIFACT_IGNORE_GREEN=PASS'
```

---

### Task 4: Commit the permanent cleanup audit trail

**Files:**
- `.gitignore`
- `docs/superpowers/specs/2026-09-02-repository-consolidation-design.md`
- `docs/superpowers/plans/2026-09-02-repository-consolidation.md`
- `docs/repository-cleanup/pre-cleanup-branches-20260902.tsv`

**Interfaces:**
- Consumes: verified archive, manifest, and `.gitignore` GREEN.
- Produces: one reviewable source-only cleanup branch.

- [ ] **Step 1: Use one exact execution branch**

```powershell
$cleanupBranch = 'chore/repo-consolidation-final-20260902-v9'
git switch -C $cleanupBranch origin/$cleanupBranch
```

Expected: this is the only cleanup branch intentionally kept through PR merge; every other cleanup-attempt branch is a deletion candidate.

- [ ] **Step 2: Verify diff path allowlist**

```powershell
$allowed = @(
  '.gitignore',
  'docs/superpowers/specs/2026-09-02-repository-consolidation-design.md',
  'docs/superpowers/plans/2026-09-02-repository-consolidation.md',
  'docs/repository-cleanup/pre-cleanup-branches-20260902.tsv'
)
$changed = @(git status --porcelain | ForEach-Object { $_.Substring(3) })
$unexpected = @($changed | Where-Object { $_ -notin $allowed })
if ($unexpected.Count) { throw "STOP: unexpected paths=$($unexpected -join ',')" }
```

- [ ] **Step 3: Commit and push**

```powershell
git add .gitignore docs/superpowers/specs/2026-09-02-repository-consolidation-design.md docs/superpowers/plans/2026-09-02-repository-consolidation.md docs/repository-cleanup/pre-cleanup-branches-20260902.tsv
git commit -m 'chore: consolidate repository governance artifacts'
git push -u origin $cleanupBranch
```

Expected: source-only commit; runtime untouched.

---

### Task 5: Delete stale remote branches from the manifest

**Files:**
- Read: `docs/repository-cleanup/pre-cleanup-branches-20260902.tsv`

**Interfaces:**
- Consumes: Task 1 archive gate and Task 2 closed PRs.
- Produces: remote namespace reduced to `main` plus the active cleanup branch.

- [ ] **Step 1: Build candidates only from the manifest**

```powershell
$cleanupBranch = 'chore/repo-consolidation-final-20260902-v9'
$rows = Import-Csv 'docs\repository-cleanup\pre-cleanup-branches-20260902.tsv' -Delimiter "`t"
$delete = @($rows.branch | Where-Object { $_ -notin @('main',$cleanupBranch) })
if ($delete.Count -lt 200) { throw "STOP: suspicious delete count=$($delete.Count)" }
Write-Host "DELETE_CANDIDATE_COUNT=$($delete.Count)"
```

- [ ] **Step 2: Dry-run the exact list and assert `main` is absent**

```powershell
if ($delete -contains 'main') { throw 'STOP: main entered delete set' }
$delete | Sort-Object | ForEach-Object { Write-Host "DELETE_REMOTE_BRANCH=$_" }
```

- [ ] **Step 3: Delete every stale remote ref**

```powershell
foreach ($branch in $delete) {
  git push origin --delete $branch
  if ($LASTEXITCODE -ne 0) { throw "STOP: delete failed for $branch" }
}
```

- [ ] **Step 4: Verify only `main` and the active cleanup branch remain**

```powershell
git fetch origin --prune
$remaining = @(git ls-remote --heads origin | ForEach-Object { (($_ -split '\s+')[1]) -replace '^refs/heads/','' })
$unexpected = @($remaining | Where-Object { $_ -notin @('main',$cleanupBranch) })
if ($unexpected.Count) { throw "STOP: branches remain=$($unexpected -join ',')" }
Write-Host 'REMOTE_BRANCH_CLEANUP=PASS'
```

---

### Task 6: Merge the source-only consolidation PR

**Files:** only the four allowlisted paths from Task 4.

**Interfaces:**
- Consumes: cleaned remote namespace and active cleanup branch.
- Produces: permanent audit trail plus canonical runtime-artifact ignore rule on `main`.

- [ ] **Step 1: Open PR `chore: consolidate XAUUSD repository governance` from `chore/repo-consolidation-final-20260902-v9` to `main`**

PR body:

```text
Source-only repository hygiene. Adds the approved consolidation design/plan, pre-cleanup branch/SHA manifest, and the canonical ignore rule for Sideway runtime artifacts. Stale pre-cleanup PRs were closed and stale remote branches were deleted only after a verified external Git bundle was created. No trading/runtime mutation is part of this PR.
```

- [ ] **Step 2: Require exact-head mergeability and fresh CI GREEN**

Expected: no waived regression failures.

- [ ] **Step 3: Squash merge**

Expected: `main` advances by one source-only cleanup commit; deployed runtime remains unchanged because `RUNTIME_DEPLOYMENT=NONE`.

- [ ] **Step 4: Delete the final cleanup branch**

```powershell
git switch main
git pull --ff-only
git push origin --delete chore/repo-consolidation-final-20260902-v9
git branch -D chore/repo-consolidation-final-20260902-v9
```

Expected: no cleanup branch remains remotely.

---

### Task 7: Final verification and workflow/governance handoff

**Files:** read-only verification.

**Interfaces:**
- Consumes: merged cleanup PR.
- Produces: main-only branch namespace and an explicit handoff to workflow/ruleset cleanup.

- [ ] **Step 1: Verify remote heads are exactly `main`**

```powershell
$remaining = @(git ls-remote --heads origin | ForEach-Object { (($_ -split '\s+')[1]) -replace '^refs/heads/','' })
if ($remaining.Count -ne 1 -or $remaining[0] -ne 'main') { throw "STOP: final branches=$($remaining -join ',')" }
Write-Host 'REMOTE_BRANCH_FINAL=MAIN_ONLY'
```

- [ ] **Step 2: Verify bundle still validates**

```powershell
git bundle verify 'F:\Project\XAUUSD_AI_MASTER\archive\xauusd-ai-master-pre-cleanup-20260902.bundle'
if ($LASTEXITCODE -ne 0) { throw 'STOP: archive verification failed' }
Write-Host 'POST_CLEANUP_ARCHIVE_VERIFY=PASS'
```

- [ ] **Step 3: Verify canonical ignore rule**

```powershell
git check-ignore -q scripts/.phase7c-sideway-runtime-99999.mjs
if ($LASTEXITCODE -ne 0) { throw 'STOP: canonical runtime artifact ignore missing' }
Write-Host 'RUNTIME_ARTIFACT_IGNORE_FINAL=PASS'
```

- [ ] **Step 4: Verify stale PR count is zero and record safety state**

Expected checkpoint:

```text
CANONICAL_REPO=thiennguyen3004931-sudo/xauusd-ai-master
CANONICAL_BRANCH=main
REMOTE_BRANCH_FINAL=MAIN_ONLY
STALE_PRE_CLEANUP_PRS=0
ARCHIVE_BUNDLE=VERIFIED
BRANCH_MANIFEST=PRESERVED_ON_MAIN
WORKFLOW_DELETION=DEFERRED
MAIN_PROTECTION_RULESET=DEFERRED_UNTIL_REQUIRED_CI_MAP_IS_CANONICAL
ORDER_MUTATION=NONE
LIVE_TEST_ORDER=NONE
MODE_CHANGE=NONE
ARM_CHANGE=NONE
BRIDGE_RESTART=NONE
EXECUTOR_RESTART=NONE
WEB_API_RESTART=NONE
RUNTIME_DEPLOYMENT=NONE
```

The next plan maps `.github/workflows` to live contracts, removes only redundant/obsolete workflows, proves retained regression coverage GREEN, and then enables an appropriate `main` protection/ruleset against the retained required checks.
