# Public / Private Repository Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a new private `thiennguyen3004931-sudo/xauusd-ai-master-core` repository the only canonical home for proprietary Master behavior while converting the existing public `thiennguyen3004931-sudo/xauusd-ai-master` repository into a protocol/follower/distribution repository without mutating production trading runtime.

**Architecture:** Bootstrap the private repository from an exact accepted public Git commit before sanitizing the public current head. Preserve provenance, then enforce a one-way dependency boundary: public protocol/contracts may be consumed by private Master/Core, but public source/CI must never consume private source or private secrets. Historical public exposure is treated as irreversible; credential findings are remediated by rotation/revocation rather than deletion claims.

**Tech Stack:** Git/GitHub, Node.js 24, TypeScript 5.9, pnpm 10.18.0, Turbo 2.5, Vitest 2.1.9, GitHub Actions, Ed25519 via Node `crypto`, Gitleaks v8 container for history scanning.

**Spec:** `docs/superpowers/specs/2026-09-15-public-private-repository-split-design.md`

## Global Constraints

- Existing public repository remains `thiennguyen3004931-sudo/xauusd-ai-master` until source migration is accepted.
- New canonical Master/Core repository is `thiennguyen3004931-sudo/xauusd-ai-master-core` and must be private before the first source push.
- No private signing key, device private key, credential, token, password, or long-lived secret may be committed to either repository.
- Previously public Git history is considered potentially copied; history rewrite is not accepted as secrecy or credential remediation.
- Public responsibilities are limited to protocol, cryptographic verification, installation-proof client primitives, generic authorization contracts, follower/distribution code, public-safe schemas/docs/tests/CI.
- Private responsibilities include proprietary strategy selection, signal/decision logic, trade-management logic, Master-specific risk decisions, proprietary analytics, Master orchestration, pre-sanitization Copy Events, signing service, license administration, and private deployment/runtime tooling.
- Dependency direction is strictly one-way: PUBLIC contracts -> PRIVATE Master/Core -> sanitized signed lifecycle commands -> PUBLIC follower.
- Public build and CI must succeed with zero private repository access.
- P3 canonical implementation is `@xauusd/installation-proof` from PR #359; PR #360 must be superseded, not merged as a second identity/proof system.
- Production follower key persistence remains blocked until an OS-protected private-key store is separately accepted.
- `PRODUCTION_MUTATION=NONE`.
- `BOT_RUNTIME_MUTATION=NONE`.
- `MODE_MUTATION=NONE`.
- `ARM_MUTATION=NONE`.
- `TASK_MUTATION=NONE`.
- `PROCESS_MUTATION=NONE`.
- `ORDER_MUTATION=NONE`.
- `POSITION_MUTATION=NONE`.
- `LIVE_TEST_ORDER=NONE`.
- Production cutover is outside this plan. This plan may create read-only cutover evidence and a later rollout plan, but it may not perform rollout.

---

## File Structure

### Public repository

- `security/repository-boundary.json` — exact allowlist for `SAFE_PUBLIC`; every non-allowlisted tracked path is `PRIVATE_REQUIRED`.
- `security/credential-remediation.json` — redacted secret-finding fingerprints and remediation status only.
- `scripts/security/classify-repository.mjs` — deterministic default-private classifier.
- `scripts/security/check-public-change-freeze.mjs` — blocks add/modify/rename of private-required paths while allowing deletion.
- `scripts/security/check-public-boundary.mjs` — final current-head gate requiring zero private-required tracked files.
- `scripts/security/check-distribution-artifact.mjs` — rejects private-module references or secret material in public artifacts.
- `.github/workflows/public-private-boundary-ci.yml` — read-only boundary/history gate.
- `.github/workflows/public-distribution-ci.yml` — final public build/test/artifact gate.
- `docs/public/SECURITY-BOUNDARY.md` — public-safe responsibility statement.

### Private repository

- `security/private-bootstrap-attestation.json` — exact public source commit/tree and matching private bootstrap commit/tree.
- `security/public-contract.lock.json` — pinned public commit and public package tree hashes.
- `scripts/security/verify-private-bootstrap.mjs` — validates provenance attestation.
- `scripts/security/verify-public-contract-lock.mjs` — validates private copies of public contracts against pinned public Git objects.
- `scripts/security/check-private-secrets.mjs` — rejects tracked key/credential material.
- `.github/workflows/private-master-core-ci.yml` — private build/regression/security gate.
- `scripts/security/preflight-private-cutover.ps1` — read-only source/runtime cutover evidence.

---

### Task 1: M0 secrecy freeze and default-private classifier

**Files:**
- Create: `security/repository-boundary.json`
- Create: `scripts/security/classify-repository.mjs`
- Create: `scripts/security/classify-repository.test.mjs`
- Create: `scripts/security/check-public-change-freeze.mjs`
- Create: `.github/workflows/public-private-boundary-ci.yml`

**Interfaces:**
- Produces: `classifyPath(path): "SAFE_PUBLIC" | "PRIVATE_REQUIRED"`.
- Rule: only explicit allowlist entries are public; every other tracked path is private-required.
- Produces CLI: `node scripts/security/check-public-change-freeze.mjs <baseSha> <headSha>`.

- [ ] **Step 1: Write RED classifier tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { classifyPath } from "./classify-repository.mjs";

test("public allowlist wins and all other paths default private", () => {
  assert.equal(classifyPath("packages/copy-protocol/src/index.ts"), "SAFE_PUBLIC");
  assert.equal(classifyPath("packages/license-service/src/index.ts"), "SAFE_PUBLIC");
  assert.equal(classifyPath("packages/installation-proof/src/challenge.ts"), "SAFE_PUBLIC");
  assert.equal(classifyPath("scripts/test-bot-ip-protection-p1-boundary.mjs"), "SAFE_PUBLIC");
  assert.equal(classifyPath("packages/strategy-engine/src/index.ts"), "PRIVATE_REQUIRED");
  assert.equal(classifyPath("apps/api/src/index.ts"), "PRIVATE_REQUIRED");
  assert.equal(classifyPath("unexpected/new-module.ts"), "PRIVATE_REQUIRED");
});
```

- [ ] **Step 2: Run RED**

Run: `node --test scripts/security/classify-repository.test.mjs`

Expected: FAIL because the classifier does not exist.

- [ ] **Step 3: Add the exact public allowlist**

```json
{
  "version": 1,
  "safePublicPrefixes": [
    "packages/copy-protocol/",
    "packages/license-service/",
    "packages/installation-proof/"
  ],
  "safePublicExact": [
    ".gitignore",
    "README.md",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "turbo.json",
    "tsconfig.base.json",
    "security/repository-boundary.json",
    "security/credential-remediation.json",
    "docs/public/SECURITY-BOUNDARY.md",
    ".github/workflows/bot-ip-protection-p1-copy-protocol-ci.yml",
    ".github/workflows/bot-ip-protection-p2-license-service-ci.yml",
    ".github/workflows/bot-ip-protection-p3-installation-proof-ci.yml",
    ".github/workflows/public-private-boundary-ci.yml",
    ".github/workflows/public-distribution-ci.yml",
    "scripts/test-bot-ip-protection-p1-boundary.mjs",
    "scripts/test-bot-ip-protection-p2-boundary.mjs",
    "scripts/test-bot-ip-protection-p3-boundary.mjs",
    "scripts/security/classify-repository.mjs",
    "scripts/security/classify-repository.test.mjs",
    "scripts/security/check-public-change-freeze.mjs",
    "scripts/security/validate-credential-remediation.mjs",
    "scripts/security/validate-credential-remediation.test.mjs",
    "scripts/security/check-public-boundary.mjs",
    "scripts/security/check-distribution-artifact.mjs",
    "scripts/security/check-distribution-artifact.test.mjs",
    "scripts/security/accept-public-private-split.mjs",
    "docs/superpowers/plans/2026-09-15-bot-ip-protection-p3-installation-proof.md"
  ]
}
```

- [ ] **Step 4: Implement the default-private classifier**

```js
export function classifyPath(path) {
  if (SAFE_EXACT.has(path)) return "SAFE_PUBLIC";
  if (SAFE_PREFIXES.some((prefix) => path.startsWith(prefix))) return "SAFE_PUBLIC";
  return "PRIVATE_REQUIRED";
}
```

`check-public-change-freeze.mjs` parses `git diff --name-status <baseSha>...<headSha>` and rejects any non-deletion change whose resulting path is `PRIVATE_REQUIRED`. Pure deletion `D` is allowed so migration can remove proprietary files.

- [ ] **Step 5: Run GREEN**

```bash
node --test scripts/security/classify-repository.test.mjs
node scripts/security/classify-repository.mjs --tracked
```

Expected: PASS; every tracked file receives exactly one classification.

- [ ] **Step 6: Add read-only CI and commit**

Workflow uses `permissions: { contents: read }`, full checkout history, classifier test, tracked inventory, and freeze gate against PR base/head.

```bash
git add security scripts/security .github/workflows/public-private-boundary-ci.yml
git commit -m "security: freeze public private repository boundary"
```

### Task 2: M1 history secret scan and redacted remediation gate

**Files:**
- Create: `security/credential-remediation.json`
- Create: `scripts/security/validate-credential-remediation.mjs`
- Create: `scripts/security/validate-credential-remediation.test.mjs`
- Modify: `.github/workflows/public-private-boundary-ci.yml`

**Interfaces:**
- Consumes redacted Gitleaks JSON at `artifacts/security/gitleaks.json`.
- Allowed remediation statuses: `ROTATED`, `REVOKED`, `FALSE_POSITIVE_REVIEWED`.
- Ledger stores fingerprint, rule ID, path, commit, status only; never raw secret value.

- [ ] **Step 1: Write RED remediation tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { validateRemediation } from "./validate-credential-remediation.mjs";

test("scanner finding without remediation fails", () => {
  assert.throws(
    () => validateRemediation([{ Fingerprint: "abc", RuleID: "generic-api-key" }], { version: 1, findings: [] }),
    /UNREMEDIATED_SECRET_FINDING:abc/
  );
});
```

- [ ] **Step 2: Run RED**

Run: `node --test scripts/security/validate-credential-remediation.test.mjs`

Expected: FAIL because the validator does not exist.

- [ ] **Step 3: Implement the ledger validator**

Initial ledger:

```json
{
  "version": 1,
  "findings": []
}
```

Validator rejects duplicate fingerprints, unknown statuses, and any field named `secret`, `value`, `token`, `password`, `privateKey`, or `credentialValue`.

- [ ] **Step 4: Add full-history scan**

```bash
mkdir -p artifacts/security
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.24.2 detect \
  --source=/repo \
  --redact \
  --log-opts="--all" \
  --report-format=json \
  --report-path=/repo/artifacts/security/gitleaks.json \
  --exit-code=0
node scripts/security/validate-credential-remediation.mjs \
  artifacts/security/gitleaks.json security/credential-remediation.json
```

If the scan reports a real credential, rotate/revoke it outside Git first, then add only redacted fingerprint metadata and `ROTATED` or `REVOKED`. A reviewed false positive may use `FALSE_POSITIVE_REVIEWED`.

- [ ] **Step 5: Run GREEN and commit**

```bash
node --test scripts/security/validate-credential-remediation.test.mjs
node scripts/security/validate-credential-remediation.mjs artifacts/security/gitleaks.json security/credential-remediation.json
git add security/credential-remediation.json scripts/security .github/workflows/public-private-boundary-ci.yml
git commit -m "security: gate historical secret remediation"
```

### Task 3: Canonicalize P3 before the repository split

**Files:**
- Canonical plan: `docs/superpowers/plans/2026-09-15-bot-ip-protection-p3-installation-proof.md`.
- Canonical package: `packages/installation-proof/**` from PR #359.
- Superseded package: `packages/installation-identity/**` from PR #360; do not merge.

**Interfaces:**
- Canonical public package: `@xauusd/installation-proof`.
- Canonical key representation: Ed25519 SPKI DER -> canonical base64url.
- Canonical replay boundary: `consumeOnce(challengeId): Promise<boolean>`.

- [ ] **Step 1: Close #360 as superseded**

Add this comment:

```text
Superseded by the approved Public/Private split and the stricter P3 installation-proof contract in #359. Do not merge a second canonical identity/proof system.
```

Close PR #360 without merge.

- [ ] **Step 2: Update #359 onto current public `main`**

Keep changes limited to `packages/installation-proof/**`, `.github/workflows/bot-ip-protection-p3-installation-proof-ci.yml`, `scripts/test-bot-ip-protection-p3-boundary.mjs`, `pnpm-lock.yaml`, and the P3 plan. Preserve the TDD RED history.

- [ ] **Step 3: Execute P3 to GREEN**

```bash
pnpm install --frozen-lockfile
pnpm --filter @xauusd/copy-protocol build
pnpm --filter @xauusd/installation-proof test
pnpm --filter @xauusd/installation-proof typecheck
pnpm --filter @xauusd/installation-proof build
node --test scripts/test-bot-ip-protection-p3-boundary.mjs
```

Expected: all PASS; no private-key persistence and no strategy/risk/execution/MT5 dependency.

- [ ] **Step 4: Merge #359 exact-head only after all CI is green**

Use the reviewed PR head SHA as merge precondition. Abort merge if the head moves after review.

### Task 4: M2 bootstrap private Master/Core with exact provenance

**Files in private repo:**
- Create: `security/private-bootstrap-attestation.json`
- Create: `scripts/security/write-private-bootstrap-attestation.mjs`
- Create: `scripts/security/verify-private-bootstrap.mjs`
- Create: `scripts/security/verify-private-bootstrap.test.mjs`

**Interfaces:**
- Bootstrap source is public `main` after Task 3 merge.
- Attestation fields: `publicRepository`, `publicCommit`, `publicTree`, `privateRepository`, `privateBootstrapCommit`, `privateBootstrapTree`.
- At bootstrap, public/private commit and tree must be byte-identical.

- [ ] **Step 1: Create the private repository before pushing source**

```bash
gh repo create thiennguyen3004931-sudo/xauusd-ai-master-core --private
gh repo view thiennguyen3004931-sudo/xauusd-ai-master-core --json visibility,nameWithOwner
```

Expected: visibility is `PRIVATE`.

- [ ] **Step 2: Push branches and tags only**

```bash
git clone --bare https://github.com/thiennguyen3004931-sudo/xauusd-ai-master.git xauusd-ai-master-core.git
cd xauusd-ai-master-core.git
git remote add private git@github.com:thiennguyen3004931-sudo/xauusd-ai-master-core.git
git push private 'refs/heads/*:refs/heads/*'
git push private 'refs/tags/*:refs/tags/*'
gh repo edit thiennguyen3004931-sudo/xauusd-ai-master-core --default-branch main
```

Do not use `git push --mirror`; hidden pull-request refs are not part of the provenance contract.

- [ ] **Step 3: Clone private normally and add a read-only public remote**

```bash
cd ..
git clone git@github.com:thiennguyen3004931-sudo/xauusd-ai-master-core.git xauusd-ai-master-core
cd xauusd-ai-master-core
git remote add public https://github.com/thiennguyen3004931-sudo/xauusd-ai-master.git
git fetch public main
```

- [ ] **Step 4: Write RED provenance test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { verifyBootstrap } from "./verify-private-bootstrap.mjs";

test("different bootstrap trees are rejected", () => {
  assert.throws(
    () => verifyBootstrap({ publicCommit: "a", privateBootstrapCommit: "a", publicTree: "111", privateBootstrapTree: "222" }),
    /BOOTSTRAP_TREE_MISMATCH/
  );
});
```

- [ ] **Step 5: Generate attestation from Git object IDs**

```bash
PUBLIC_COMMIT=$(git rev-parse public/main)
PUBLIC_TREE=$(git rev-parse public/main^{tree})
PRIVATE_COMMIT=$(git rev-parse HEAD)
PRIVATE_TREE=$(git rev-parse HEAD^{tree})
node scripts/security/write-private-bootstrap-attestation.mjs \
  "$PUBLIC_COMMIT" "$PUBLIC_TREE" "$PRIVATE_COMMIT" "$PRIVATE_TREE"
```

The writer exits non-zero unless public/private commit IDs and tree IDs match exactly.

- [ ] **Step 6: Run GREEN and commit privately**

```bash
node --test scripts/security/verify-private-bootstrap.test.mjs
node scripts/security/verify-private-bootstrap.mjs security/private-bootstrap-attestation.json
git add security scripts/security
git commit -m "security: attest private master core bootstrap"
```

### Task 5: M3 private Master/Core CI and secret boundary

**Files in private repo:**
- Create: `scripts/security/check-private-secrets.mjs`
- Create: `scripts/security/check-private-secrets.test.mjs`
- Create: `.github/workflows/private-master-core-ci.yml`

**Interfaces:**
- Produces `PRIVATE_MASTER_CORE_CI=PASS` only after build, tests, regression gates, provenance, and tracked-secret checks pass.

- [ ] **Step 1: Write RED secret-boundary tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { inspectTrackedPath } from "./check-private-secrets.mjs";

test("tracked key and credential filenames fail", () => {
  assert.equal(inspectTrackedPath("keys/master-signing.pem"), "REJECT");
  assert.equal(inspectTrackedPath("config/prod.env"), "REJECT");
  assert.equal(inspectTrackedPath("docs/public/SECURITY-BOUNDARY.md"), "ALLOW");
});
```

- [ ] **Step 2: Implement fail-closed tracked-file checks**

Reject tracked `*.pem`, `*.p12`, `*.pfx`, `.env`, `.env.*` except `*.example`, `id_rsa*`, `id_ed25519*`, and filenames containing `private-key`, `signing-key`, `credential`, or `secret`, except synthetic test fixtures containing no real credential values.

- [ ] **Step 3: Add private CI**

```bash
pnpm install --frozen-lockfile
node --test scripts/security/check-private-secrets.test.mjs
node scripts/security/check-private-secrets.mjs --tracked
node scripts/security/verify-private-bootstrap.mjs security/private-bootstrap-attestation.json
pnpm test
pnpm build
```

Do not weaken existing strategy/Phase7 regression gates; root `pnpm test` and existing canonical workflows remain required.

- [ ] **Step 4: Commit privately and require GREEN before public sanitization**

```bash
git add scripts/security .github/workflows/private-master-core-ci.yml
git commit -m "ci: establish private master core acceptance gate"
```

### Task 6: M4 sanitize the public current head

**Files in public repo:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `turbo.json`
- Modify: `pnpm-lock.yaml`
- Retain: `tsconfig.base.json`
- Retain: `packages/copy-protocol/**`
- Retain: `packages/license-service/**`
- Retain: `packages/installation-proof/**`
- Retain: P1/P2/P3 boundary scripts and P1/P2/P3 workflows named in Task 1 allowlist.
- Create: `docs/public/SECURITY-BOUNDARY.md`
- Create: `scripts/security/check-public-boundary.mjs`
- Delete: every other tracked file classified `PRIVATE_REQUIRED`.

**Interfaces:**
- Produces public workspace with zero dependency on private source.

- [ ] **Step 1: Write RED public-boundary gate before deletion**

`check-public-boundary.mjs` runs `git ls-files`, classifies every path, and throws `PRIVATE_REQUIRED_PRESENT:<path>` if any current tracked path is private-required.

Run: `node scripts/security/check-public-boundary.mjs`

Expected: FAIL on the current unsanitized public tree.

- [ ] **Step 2: Generate and inspect the exact removal list**

```bash
node scripts/security/classify-repository.mjs --tracked --emit-private > .private-removal-list.txt
```

Every emitted line must classify as `PRIVATE_REQUIRED` under the committed manifest.

- [ ] **Step 3: Delete exactly the private-required current-head files**

```bash
while IFS= read -r path; do git rm --ignore-unmatch -- "$path"; done < .private-removal-list.txt
rm .private-removal-list.txt
```

Do not rewrite history.

- [ ] **Step 4: Replace the public root with public-only scripts**

Root `package.json` removes direct dependencies on private packages and exposes:

```json
{
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "security:boundary": "node scripts/security/check-public-boundary.mjs"
  }
}
```

Add `"typecheck": {}` to `turbo.json` tasks while keeping existing build/test behavior.

- [ ] **Step 5: Replace README and add public boundary doc**

README and `docs/public/SECURITY-BOUNDARY.md` may describe protocol, license verification, installation proof, follower/distribution responsibilities, build commands, and security boundary only. They must not contain proprietary trading thresholds, formulas, rule scores, internal strategy state, or secret values.

- [ ] **Step 6: Reinstall and run GREEN**

```bash
pnpm install
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm typecheck
node scripts/security/check-public-boundary.mjs
node --test scripts/test-bot-ip-protection-p1-boundary.mjs
node --test scripts/test-bot-ip-protection-p2-boundary.mjs
node --test scripts/test-bot-ip-protection-p3-boundary.mjs
```

Expected: PASS with zero private-required tracked file.

- [ ] **Step 7: Commit sanitization**

```bash
git add -A
git commit -m "security: sanitize public distribution repository"
```

### Task 7: M5/M6 one-way contracts and distribution artifact security

**Files in public repo:**
- Create: `scripts/security/check-distribution-artifact.mjs`
- Create: `scripts/security/check-distribution-artifact.test.mjs`
- Create: `.github/workflows/public-distribution-ci.yml`

**Files in private repo:**
- Create: `security/public-contract.lock.json`
- Create: `scripts/security/write-public-contract-lock.mjs`
- Create: `scripts/security/verify-public-contract-lock.mjs`
- Create: `scripts/security/verify-public-contract-lock.test.mjs`

**Interfaces:**
- Public canonical contract packages: `packages/copy-protocol`, `packages/license-service`, `packages/installation-proof`.
- Private lock stores exact public commit plus exact Git tree IDs for those three paths.

- [ ] **Step 1: Write RED public artifact test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { inspectTextArtifact } from "./check-distribution-artifact.mjs";

test("private module reference is rejected", () => {
  assert.throws(() => inspectTextArtifact('import "@xauusd/strategy-engine"'), /FORBIDDEN_PRIVATE_REFERENCE/);
});
```

- [ ] **Step 2: Implement artifact scanner**

Scan public `dist/**`, package manifests, and source maps. Reject private package references, private path prefixes, `-----BEGIN PRIVATE KEY-----`, `-----BEGIN OPENSSH PRIVATE KEY-----`, and source maps embedding private paths.

- [ ] **Step 3: Add public distribution CI**

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm typecheck
node scripts/security/check-public-boundary.mjs
node scripts/security/check-distribution-artifact.mjs
```

Workflow permission is `contents: read`; it does not check out or authenticate to the private repository.

- [ ] **Step 4: Write private public-contract lock generator**

`write-public-contract-lock.mjs` accepts a public commit SHA and obtains trees using:

```bash
git rev-parse <publicCommit>:packages/copy-protocol
git rev-parse <publicCommit>:packages/license-service
git rev-parse <publicCommit>:packages/installation-proof
```

The script writes actual commit/tree IDs to `security/public-contract.lock.json`; operators do not hand-enter hash values.

- [ ] **Step 5: Write RED private lock test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { comparePackageTrees } from "./verify-public-contract-lock.mjs";

test("contract drift fails closed", () => {
  assert.throws(
    () => comparePackageTrees({ "packages/copy-protocol": "aaa" }, { "packages/copy-protocol": "bbb" }),
    /PUBLIC_CONTRACT_DRIFT:packages\/copy-protocol/
  );
});
```

- [ ] **Step 6: Verify private copies against pinned public Git objects**

Private repo fetches only the pinned public commit through the read-only `public` remote and compares the three public tree IDs to local private tree IDs. Any mismatch fails closed.

- [ ] **Step 7: Run GREEN and commit both repositories**

Public:

```bash
node --test scripts/security/check-distribution-artifact.test.mjs
node scripts/security/check-distribution-artifact.mjs
git add scripts/security .github/workflows/public-distribution-ci.yml
git commit -m "ci: enforce public distribution artifact boundary"
```

Private:

```bash
node --test scripts/security/verify-public-contract-lock.test.mjs
node scripts/security/verify-public-contract-lock.mjs security/public-contract.lock.json
git add security/public-contract.lock.json scripts/security
git commit -m "security: pin public protocol contract source"
```

### Task 8: M7 source-complete acceptance matrix

**Files:**
- Public: create `scripts/security/accept-public-private-split.mjs`
- Private: create `scripts/security/accept-master-core-split.mjs`

**Interfaces:**
- Acceptance output is machine-readable key/value lines and must not print secret values.

- [ ] **Step 1: Run public acceptance**

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm typecheck
node scripts/security/check-public-boundary.mjs
node scripts/security/check-distribution-artifact.mjs
node scripts/security/accept-public-private-split.mjs
```

Required verdicts:

```text
PUBLIC_BUILD=PASS
PRIVATE_SOURCE_PRESENT=FALSE
PRIVATE_IMPORT_PRESENT=FALSE
PUBLIC_CI_NEEDS_PRIVATE_REPO=FALSE
DISTRIBUTION_ARTIFACT_PRIVATE_REF=FALSE
P3_CANONICAL=INSTALLATION_PROOF
P3_DUPLICATE_IMPLEMENTATION=FALSE
```

- [ ] **Step 2: Run private acceptance**

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
node scripts/security/verify-private-bootstrap.mjs security/private-bootstrap-attestation.json
node scripts/security/verify-public-contract-lock.mjs security/public-contract.lock.json
node scripts/security/check-private-secrets.mjs --tracked
node scripts/security/accept-master-core-split.mjs
```

Required verdicts:

```text
PRIVATE_BUILD=PASS
MASTER_REGRESSION=PASS
PUBLIC_CONTRACT_LOCK=PASS
PRIVATE_SIGNING_KEY_TRACKED=FALSE
PRIVATE_DEPENDS_ON_PUBLIC_CONTRACTS=TRUE
PUBLIC_DEPENDS_ON_PRIVATE_SOURCE=FALSE
PRODUCTION_CUTOVER=NOT_PERFORMED
```

- [ ] **Step 3: Re-run full public history scan**

Run the Task 2 Gitleaks command again and require every reported fingerprint to be covered by `security/credential-remediation.json` with an accepted remediation status.

- [ ] **Step 4: Record exact accepted heads and trees**

```bash
PUBLIC_HEAD=$(git -C ../xauusd-ai-master rev-parse HEAD)
PUBLIC_TREE=$(git -C ../xauusd-ai-master rev-parse HEAD^{tree})
PRIVATE_HEAD=$(git -C ../xauusd-ai-master-core rev-parse HEAD)
PRIVATE_TREE=$(git -C ../xauusd-ai-master-core rev-parse HEAD^{tree})
printf "PUBLIC_HEAD=%s\nPUBLIC_TREE=%s\nPRIVATE_HEAD=%s\nPRIVATE_TREE=%s\n" \
  "$PUBLIC_HEAD" "$PUBLIC_TREE" "$PRIVATE_HEAD" "$PRIVATE_TREE"
```

Source split is accepted only if both exact-head CI sets are green and neither accepted head moved after review.

### Task 9: M8 read-only production cutover preflight and hard stop

**Files in private repo:**
- Create: `scripts/security/preflight-private-cutover.ps1`
- Create: `docs/superpowers/plans/2026-09-15-private-master-production-cutover.md`

**Interfaces:**
- Preflight is read-only and prints evidence only.
- This task must not change runtime source, tasks, processes, mode, ARM, orders, or positions.

- [ ] **Step 1: Implement read-only invariant header**

```powershell
$ErrorActionPreference = 'Stop'
Write-Output 'READ_ONLY=TRUE'
Write-Output 'GIT_MUTATION=NONE'
Write-Output 'TASK_MUTATION=NONE'
Write-Output 'PROCESS_MUTATION=NONE'
Write-Output 'MODE_MUTATION=NONE'
Write-Output 'ARM_MUTATION=NONE'
Write-Output 'ORDER_MUTATION=NONE'
Write-Output 'POSITION_MUTATION=NONE'
Write-Output 'LIVE_TEST_ORDER=NONE'
```

- [ ] **Step 2: Collect exact private/source evidence without mutation**

The script may read accepted private HEAD/tree, deployment/source attestation, runtime health, bot mode, ARM state, open positions, and pending orders. It prints:

```text
ACCEPTED_PRIVATE_HEAD=<actual sha read at runtime>
ACCEPTED_PRIVATE_TREE=<actual tree read at runtime>
RUNTIME_SOURCE_HEAD=<actual sha or UNPROVEN>
RUNTIME_SOURCE_TREE=<actual tree or UNPROVEN>
SOURCE_EQUIVALENCE=PASS|FAIL|UNPROVEN
CUTOVER_READY=TRUE|FALSE
```

`CUTOVER_READY=TRUE` is allowed only when source equivalence is `PASS` and Task 8 acceptance is green.

- [ ] **Step 3: Write the separate production cutover plan using Task 8 exact heads**

The cutover plan records accepted public/private heads, rollback source, exact deployment/recovery files discovered by the read-only preflight, and this final gate:

```text
EXECUTION_REQUIRES_SEPARATE_OPERATOR_APPROVAL=TRUE
```

It contains no mutation command and is not executed in this plan.

- [ ] **Step 4: Commit privately and stop**

```bash
git add scripts/security/preflight-private-cutover.ps1 docs/superpowers/plans/2026-09-15-private-master-production-cutover.md
git commit -m "docs(security): prepare private master cutover preflight"
```

Stop before production rollout.

---

## Final Acceptance Contract

```text
PRIVATE_MASTER_CORE_EXISTS=TRUE
PRIVATE_MASTER_CORE_VISIBILITY=PRIVATE
PRIVATE_BUILD=PASS
MASTER_REGRESSION=PASS
PUBLIC_BUILD=PASS
PUBLIC_PRIVATE_REQUIRED_FILES=0
PUBLIC_PRIVATE_IMPORTS=0
PUBLIC_CI_PRIVATE_ACCESS=0
SECRET_HISTORY_SCAN=PASS
CREDIBLE_SECRET_FINDINGS_REMEDIATED=TRUE
P3_CANONICAL=INSTALLATION_PROOF
P3_DUPLICATE_IMPLEMENTATION=FALSE
PUBLIC_CONTRACT_LOCK=PASS
DISTRIBUTION_ARTIFACT_PRIVATE_REF=FALSE
PRODUCTION_CUTOVER=NOT_PERFORMED
```

Execution order is fixed:

```text
M0 boundary freeze
-> M1 history/secret audit
-> canonicalize P3
-> M2 private bootstrap
-> M3 private CI/equivalence
-> M4 sanitize public current head
-> M5/M6 one-way contracts + artifact security
-> M7 source acceptance
-> M8 read-only cutover preflight
-> STOP for separate production rollout approval
```
