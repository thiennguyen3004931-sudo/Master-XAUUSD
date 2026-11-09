#!/usr/bin/env node
/**
 * Pure offline source-release attestation.
 * No bridge, MT5, API, GitHub network or production runtime calls.
 * Git operations below are local and READ ONLY.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const manifestFile = new URL("../../docs/operations/reversal-hotfix-production-release-manifest-20261029.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true,
  }).trim();
}
function gitAncestor(ancestor, descendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      stdio: "pipe",
      timeout: 20000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}
function gitBlob(commit, path) {
  return git("rev-parse", `${commit}:${path}`);
}
function assertCommit(value) {
  assert.match(value, /^[a-f0-9]{40}$/, "SHA must be fully pinned");
  assert.equal(git("cat-file", "-t", value), "commit", `Git commit must exist: ${value}`);
}
function equalPathSets(actual, expected) {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.repository, "thiennguyen3004931-sudo/xauusd-ai-master-core");
if (process.env.GITHUB_REPOSITORY) {
  assert.equal(process.env.GITHUB_REPOSITORY, manifest.repository);
}
const base = manifest.productionBaseline;
const target = manifest.isolatedHotfix;
const mainAnchor = manifest.canonicalMainAncestryAnchor;
for (const sha of [base, target, mainAnchor]) assertCommit(sha);
assert.equal(git("rev-parse", `${base}^{tree}`), manifest.productionBaselineTree);
assert.equal(git("rev-parse", `${target}^{tree}`), manifest.isolatedHotfixTree);
assert.ok(gitAncestor(base, target), "Hotfix must be a fast-forward descendant of production baseline");
assert.ok(gitAncestor(target, mainAnchor), "Hotfix must be reachable from pinned canonical main");
assert.ok(gitAncestor(mainAnchor, "HEAD"), "Release evidence must be reviewed on canonical main ancestry");

const expectedFiles = manifest.requiredChangedPaths;
const changedFiles = git("diff", "--name-only", "--no-renames", base, target).split(/\r?\n/).filter(Boolean);
equalPathSets(changedFiles, expectedFiles);
for (const path of ["scripts/run-phase7c-trend-controller.mjs", "scripts/phase7c-auto-live-reversal-lock.mjs", "scripts/phase7c-auto-live-reversal-lock.test.mjs"]) {
  const sha = manifest.codeBlobs[path];
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.equal(gitBlob(target, path), sha, `Hotfix source blob mismatch: ${path}`);
  assert.equal(gitBlob("HEAD", path), sha, `Canonical source must be bit-identical: ${path}`);
}
for (const [path, sha] of Object.entries(manifest.unchangedRolloutBlobs)) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  for (const rev of [base, target, "HEAD"]) {
    assert.equal(gitBlob(rev, path), sha, `Rollout safety dependency changed: ${path} @ ${rev}`);
  }
}
const workflowPath = ".github/workflows/phase7c-prod-reversal-hotfix-readonly-preflight.yml";
const preflight = readFileSync(new URL("../../" + workflowPath, import.meta.url), "utf8");
assert.equal(gitBlob(target, workflowPath), gitBlob("HEAD", workflowPath), "Manual LIVE preflight must match hotfix");
assert.match(preflight, /^on:\s*\n\s*workflow_dispatch:/m);
assert.match(preflight, /operator_confirmed_online:/);
assert.match(preflight, /if:\s*\$\{\{ inputs\.operator_confirmed_online == true \}\}/);
assert.doesNotMatch(preflight, /^\s*(?:schedule|pull_request|push):/m, "LIVE preflight cannot auto-trigger");
assert.doesNotMatch(preflight, /Invoke-RestMethod\s+-Method\s+(POST|PATCH|PUT|DELETE)/i);
assert.doesNotMatch(preflight, /Invoke-WebRequest\s+-Method\s+(POST|PATCH|PUT|DELETE)/i);

assert.equal(manifest.testEvidence.length, 2);
for (const check of manifest.testEvidence) {
  assert.equal(check.commit, target, "Evidence must be pinned to exact hotfix SHA");
  assert.equal(check.conclusion, "success");
  assert.ok(Number.isInteger(check.runId) && check.runId > 0);
}
assert.equal(manifest.rollbackSource.commit, base);
assert.equal(manifest.rollbackSource.tree, manifest.productionBaselineTree);
assert.equal(manifest.rollbackSource.automaticRollback, false);
assert.equal(manifest.constraints.offlineExpected, true);
assert.equal(manifest.constraints.liveValidationDeferred, true);
assert.equal(manifest.constraints.requiresFreshOperatorOnlineConfirmation, true);
assert.equal(manifest.constraints.productionCutoverAllowed, false);
for (const flag of ["mutateBotMode", "mutateArm", "sendLiveOrders"]) assert.equal(manifest.constraints[flag], false);

const outcome = {
  release: manifest.release,
  result: "PASS",
  baseline: base,
  hotfix: target,
  mainAncestryAnchor: mainAnchor,
  actualSourceHead: git("rev-parse", "HEAD"),
  changedFiles,
  protectedBlobsVerified: Object.keys(manifest.codeBlobs),
  unchangedDeploymentDependenciesVerified: Object.keys(manifest.unchangedRolloutBlobs),
  ciRunIdsRecorded: manifest.testEvidence.map((x) => x.runId),
  livePreflightStatus: "DEFERRED_OFFLINE_EXPECTED",
  productionCutoverAuthorized: false,
  brokerNetworkCalls: 0,
  tradingMutations: 0,
};
console.log(JSON.stringify(outcome, null, 2));
