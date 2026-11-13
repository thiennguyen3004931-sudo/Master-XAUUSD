import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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
  assert.match(
    source,
    /if:\s*github\.event_name\s*!=\s*[\"']pull_request[\"']\s*\|\|\s*github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/,
  );
});

test("private Master/Core CI checks out and verifies the exact trusted head", () => {
  const source = readWorkflow();

  assert.match(
    source,
    /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|\s*github\.sha\s*\}\}/,
  );
  assert.match(
    source,
    /EXPECTED_HEAD:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|\s*github\.sha\s*\}\}/,
  );
  assert.match(source, /RUNNER_NAME=\$env:RUNNER_NAME/);
  assert.match(source, /git rev-parse HEAD/);
  assert.match(
    source,
    /if \(\$actualHead -ne \$env:EXPECTED_HEAD\) \{[\s\S]*?CHECKED_OUT_HEAD_MISMATCH[\s\S]*?exit 1[\s\S]*?\}/,
  );
});

test("private Master/Core CI coalesces PR runs and does not duplicate them on branch push", () => {
  const source = readWorkflow();

  assert.doesNotMatch(source, /^\s{2}push:\s*$/m);
  assert.match(
    source,
    /concurrency:\s*\n\s*group:\s*private-master-core-\$\{\{\s*github\.event\.pull_request\.number\s*\|\|\s*github\.ref\s*\}\}/,
  );
  assert.match(source, /cancel-in-progress:\s*true/);
});

test("private Master/Core CI uses built-in Windows PowerShell and writes outputs as UTF-8", () => {
  const source = readWorkflow();

  assert.doesNotMatch(source, /shell:\s*pwsh\b/);
  const powershellSteps = source.match(/shell:\s*powershell\b/g) ?? [];
  assert.equal(
    powershellSteps.length,
    6,
    "all six Windows-specific steps must use built-in Windows PowerShell",
  );
  assert.match(
    source,
    /"state=PASS"\s*\|\s*Out-File\s+-FilePath\s+\$env:GITHUB_OUTPUT\s+-Encoding\s+utf8\s+-Append/,
  );
  assert.match(
    source,
    /"state=BLOCKED"\s*\|\s*Out-File\s+-FilePath\s+\$env:GITHUB_OUTPUT\s+-Encoding\s+utf8\s+-Append/,
  );
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
  assert.match(source, /node --test scripts\/security\/verify-private-bootstrap\.test\.mjs/);
  assert.match(source, /git diff --check/);
});

test("private Master/Core CI enforces the M6 one-way public contract lock", () => {
  const source = readWorkflow();

  assert.match(source, /- name:\s*M6 fetch pinned public contract/);
  assert.match(source, /security\/public-contract\.lock\.json/);
  assert.match(
    source,
    /git fetch --no-tags --depth=1 https:\/\/github\.com\/thiennguyen3004931-sudo\/xauusd-ai-master\.git \$publicCommit/,
  );
  assert.doesNotMatch(source, /git fetch[^\n]*refs\/heads\/main/);
  assert.match(
    source,
    /node --test scripts\/security\/verify-public-contract-lock\.test\.mjs/,
  );
  assert.match(source, /id:\s*m6_public_contract/);
  assert.match(
    source,
    /node scripts\/security\/verify-public-contract-lock\.mjs security\/public-contract\.lock\.json/,
  );
});

test("private Master/Core CI keeps infrastructure PASS separate from full M3 acceptance", () => {
  const source = readWorkflow();

  assert.match(
    source,
    /node scripts\/security\/verify-private-bootstrap\.mjs security\/private-bootstrap-attestation\.json/,
  );
  assert.match(source, /id:\s*m2_provenance/);
  assert.match(source, /id:\s*m6_public_contract/);
  assert.match(source, /id:\s*broader_regression/);
  assert.match(source, /continue-on-error:\s*true/);
  assert.match(source, /run:\s*pnpm test --concurrency=2\s*(?:\n|$)/);
  assert.match(source, /SELF_HOSTED_CI_INFRA=PASS/);
  assert.match(source, /M3_PRIVATE_CI=BLOCKED_M2_PROVENANCE/);
  assert.match(source, /M3_PRIVATE_CI=BLOCKED_M6_PUBLIC_CONTRACT/);
  assert.match(source, /M3_PRIVATE_CI=BLOCKED_BROADER_REGRESSION/);
  assert.match(source, /M3_PRIVATE_CI=GREEN/);
});

test("blocked M3 verdicts fail the GitHub check and expose the true gate outcomes", () => {
  const source = readWorkflow();

  assert.match(
    source,
    /\$m6\s*=\s*"\$\{\{\s*steps\.m6_public_contract\.outcome\s*\}\}"/,
  );
  assert.match(source, /M6_PUBLIC_CONTRACT_OUTCOME=\$m6/);
  assert.match(
    source,
    /if \(\$m6 -ne "success"\) \{[\s\S]*?M3_PRIVATE_CI=BLOCKED_M6_PUBLIC_CONTRACT[\s\S]*?exit 1[\s\S]*?\}/,
  );
  assert.match(
    source,
    /\$broader\s*=\s*"\$\{\{\s*steps\.broader_regression\.outcome\s*\}\}"/,
  );
  assert.doesNotMatch(
    source,
    /\$broader\s*=\s*"\$\{\{\s*steps\.broader_regression\.conclusion\s*\}\}"/,
  );
  assert.match(
    source,
    /\$broaderConclusion\s*=\s*"\$\{\{\s*steps\.broader_regression\.conclusion\s*\}\}"/,
  );
  assert.match(source, /BROAD_PRIVATE_REGRESSION_OUTCOME=\$broader/);
  assert.match(
    source,
    /BROAD_PRIVATE_REGRESSION_CONCLUSION=\$broaderConclusion/,
  );
  assert.match(
    source,
    /if \(\$provenance -ne "PASS"\) \{[\s\S]*?M3_PRIVATE_CI=BLOCKED_M2_PROVENANCE[\s\S]*?exit 1[\s\S]*?\}/,
  );
  assert.match(
    source,
    /if \(\$broader -ne "success"\) \{[\s\S]*?M3_PRIVATE_CI=BLOCKED_BROADER_REGRESSION[\s\S]*?exit 1[\s\S]*?\}/,
  );
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


test("natural position management read-only witness contract executes from exact head", () => {
  const contractPath = path.join(
    repoRoot,
    "scripts",
    "test-phase7c-natural-position-management-witness.mjs",
  );
  const implementationRelativePath =
    "scripts/phase7c-natural-position-management-witness.mjs";

  assert.equal(
    fs.existsSync(contractPath),
    true,
    "natural position management witness contract must exist",
  );

  const trackedImplementation = spawnSync(
    "git",
    ["ls-files", "--error-unmatch", implementationRelativePath],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assert.equal(
    trackedImplementation.status,
    0,
    [
      "natural position management witness implementation must be tracked in exact HEAD",
      trackedImplementation.stdout ?? "",
      trackedImplementation.stderr ?? "",
    ].join("\n"),
  );

  const result = spawnSync(
    process.execPath,
    ["--test", contractPath],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  assert.equal(
    result.status,
    0,
    [
      "natural position management witness contract failed",
      result.stdout ?? "",
      result.stderr ?? "",
    ].join("\n"),
  );
});
