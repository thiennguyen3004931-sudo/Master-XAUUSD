import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const workflowPath = path.join(
  root,
  ".github",
  "workflows",
  "private-m8-readonly-preflight.yml",
);

test("M8 read-only preflight workflow is manual, self-hosted, and fail-closed", () => {
  assert.equal(
    fs.existsSync(workflowPath),
    true,
    "private M8 read-only preflight workflow must exist",
  );

  const source = fs.readFileSync(workflowPath, "utf8");

  assert.match(source, /workflow_dispatch:/);
  assert.doesNotMatch(source, /^\s{2}(?:push|pull_request):\s*$/m);

  for (const input of [
    "expected_commit",
    "expected_tree",
    "runtime_project_root",
  ]) {
    assert.match(source, new RegExp(`^ {6}${input}:\\s*$`, "m"));
    assert.match(
      source,
      new RegExp(`^ {8}required:\\s*true\\s*$`, "m"),
    );
  }

  assert.match(
    source,
    /runs-on:\s*\[\s*self-hosted\s*,\s*Windows\s*,\s*X64\s*,\s*xauusd-core-ci\s*\]/,
  );
  assert.match(source, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(source, /ubuntu-latest|windows-latest|macos-latest/);

  assert.match(source, /ref:\s*main/);
  assert.match(source, /git rev-parse HEAD/);
  assert.match(source, /git rev-parse 'HEAD\^\{tree\}'/);
  assert.match(source, /CHECKED_OUT_HEAD_MISMATCH/);
  assert.match(source, /CHECKED_OUT_TREE_MISMATCH/);

  assert.match(
    source,
    /scripts\\security\\preflight-private-cutover\.ps1/,
  );
  assert.match(source, /-ExpectedCommit\s+\$env:EXPECTED_COMMIT/);
  assert.match(source, /-ExpectedTree\s+\$env:EXPECTED_TREE/);
  assert.match(source, /-RuntimeProjectRoot\s+\$env:RUNTIME_PROJECT_ROOT/);

  for (const forbidden of [
    /recover-phase7c-runtime-ready-stable-deploy-local\.ps1/i,
    /switch-phase7c-live-guarded-local\.ps1/i,
    /schtasks\s+\/(?:create|change|delete|run)/i,
    /Invoke-RestMethod[^\n]*-Method\s+(?:Post|Put|Patch|Delete)/i,
    /git\s+(?:checkout|switch|pull|fetch|reset|rebase|clean)\b/i,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});
