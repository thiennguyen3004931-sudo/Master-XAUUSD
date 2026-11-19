import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const workflowPath = path.join(root, ".github", "workflows", "phase7c-canonical-pr-gate.yml");

test("canonical PR gate is always-on for main and exposes stable required-check contexts", () => {
  assert.equal(fs.existsSync(workflowPath), true, "RED_TARGET: canonical PR gate workflow must exist.");
  const source = fs.readFileSync(workflowPath, "utf8");
  assert.match(source, /^name:\s*Phase7C Canonical PR Gate\s*$/m);
  assert.match(source, /pull_request:\s*\n\s*branches:\s*\n\s*-\s*main/m);
  assert.match(source, /push:\s*\n\s*branches:\s*\n\s*-\s*main/m);
  assert.doesNotMatch(source, /^\s*paths(?:-ignore)?:/m, "Canonical gate must never be path-filtered.");
  assert.match(source, /canonical-linux:\s*\n\s*name:\s*canonical-pr-linux/m);
  assert.match(source, /canonical-windows:\s*\n\s*name:\s*canonical-pr-windows/m);
});

test("canonical Linux gate covers build plus trading-critical contracts", () => {
  assert.equal(fs.existsSync(workflowPath), true, "RED_TARGET: canonical PR gate workflow must exist.");
  const source = fs.readFileSync(workflowPath, "utf8");
  for (const required of [
    "pnpm install --frozen-lockfile",
    "test-phase7c-strategy-entry-conditions-core-contract.mjs",
    "test-phase7c-trend-entry-recovery-contract.mjs",
    "test-phase7c-sideway-recovery-management-contract.mjs",
    "test-phase7c-canonical-daily-recovery-executors-contract.mjs",
    "test-phase7c-structural-sl-monotonicity.mjs",
    "phase7c-fixed-tp-trend-exit.test.mjs",
    "phase7c-fixed-tp-sideway-exit.test.mjs",
    "phase7c-execution-lock.test.mjs",
    "@xauusd/risk-engine... build",
    "@xauusd/strategy-engine... build",
    "@xauusd/api... build",
    "@xauusd/web... build",
    "git diff --check",
  ]) {
    assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing canonical Linux gate command: ${required}`);
  }

  const fixedTpIndex = source.indexOf("- name: Broker-native Fixed TP regressions");
  const apiBuildIndex = source.indexOf("pnpm --filter @xauusd/api... build");
  assert.ok(
    apiBuildIndex >= 0 && fixedTpIndex >= 0 && apiBuildIndex < fixedTpIndex,
    "RED_TARGET: compiled API must be built before Fixed TP regressions import apps/api/dist.",
  );
});

test("canonical Linux multi-command blocks fail fast on every native command", () => {
  assert.equal(fs.existsSync(workflowPath), true);
  const source = fs.readFileSync(workflowPath, "utf8");
  for (const stepName of [
    "Build and test broker risk strategy foundations",
    "Canonical strategy and recovery contracts",
    "Structural and execution safety regressions",
    "Broker-native Fixed TP regressions",
    "Build API and Web dependency graphs",
    "Parse canonical trading controllers",
  ]) {
    const start = source.indexOf(`- name: ${stepName}`);
    assert.ok(start >= 0, `missing canonical step: ${stepName}`);
    const next = source.indexOf("\n      - name:", start + 1);
    const block = source.slice(start, next >= 0 ? next : source.length);
    assert.match(block, /shell:\s*pwsh/, `${stepName} must run under PowerShell 7`);
    const commandLines = block
      .split(/\r?\n/)
      .filter((line) => /^\s+(?:pnpm|node)\s/.test(line));
    const guards = block.match(/if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/g) ?? [];
    assert.equal(
      guards.length,
      commandLines.length,
      `${stepName} must fail immediately after every native command`,
    );
  }
});

test("canonical Windows gate covers cross-shell lifecycle and LIVE source safety", () => {
  assert.equal(fs.existsSync(workflowPath), true, "RED_TARGET: canonical PR gate workflow must exist.");
  const source = fs.readFileSync(workflowPath, "utf8");
  for (const required of [
    "test-phase7c-system-lifecycle-broker-source.ps1",
    "test-phase7c-system-lifecycle-broker-contract.ps1",
    "test-phase7c-lifecycle-broker-acl-source.ps1",
    "test-phase7c-web-live-arm-demo-auto-source.ps1",
    "test-phase7c-live-arm-verifier-source.ps1",
    "test-phase7c-activation-safety-source.ps1",
    "test-phase7c-live-risk-profile-source.ps1",
  ]) {
    assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing canonical Windows gate command: ${required}`);
  }
  assert.match(source, /shell:\s*pwsh/);
  assert.match(source, /shell:\s*powershell/);
});
