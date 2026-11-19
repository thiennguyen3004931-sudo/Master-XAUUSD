import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const libraryPath = path.join(scriptsDir, "lib", "phase7c-account-mode.ps1");

function runRiskProfile(profile) {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    ". $env:PHASE7C_ACCOUNT_MODE_LIBRARY",
    "$profile = $env:PHASE7C_RISK_PROFILE_JSON | ConvertFrom-Json",
    "$result = Assert-Phase7CRiskProfile $profile 'Fixed TP risk profile'",
    "$result | ConvertTo-Json -Compress -Depth 6",
  ].join("; ");

  return spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: path.resolve(scriptsDir, ".."),
    env: {
      ...process.env,
      PHASE7C_ACCOUNT_MODE_LIBRARY: libraryPath,
      PHASE7C_RISK_PROFILE_JSON: JSON.stringify(profile),
    },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function assertPowerShellSuccess(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} must succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length > 0, `${label} must emit canonical JSON`);
  return JSON.parse(lines.at(-1));
}

test("PowerShell v1 risk profile migrates to canonical v2 with Fixed TP disabled", () => {
  const result = runRiskProfile({
    version: 1,
    trendFixedLot: 0.12,
    sidewayRiskPercent: 0.4,
    sidewayMaxLot: 0.3,
  });
  const canonical = assertPowerShellSuccess(result, "v1 risk profile migration");

  assert.deepEqual(canonical, {
    version: 2,
    trendFixedLot: 0.12,
    sidewayRiskPercent: 0.4,
    sidewayMaxLot: 0.3,
    trendFixedTpEnabled: false,
    trendFixedTpDistance: 0,
    sidewayFixedTpEnabled: false,
    sidewayFixedTpDistance: 0,
  }, "RED_TARGET: PowerShell v1 risk profiles must canonicalize to schema v2 without changing lot/risk values.");
});

test("PowerShell v2 risk profile preserves independent Trend and Sideway Fixed TP", () => {
  const result = runRiskProfile({
    version: 2,
    trendFixedLot: 0.12,
    sidewayRiskPercent: 0.4,
    sidewayMaxLot: 0.3,
    trendFixedTpEnabled: true,
    trendFixedTpDistance: 8,
    sidewayFixedTpEnabled: true,
    sidewayFixedTpDistance: 6.5,
  });
  const canonical = assertPowerShellSuccess(result, "v2 risk profile");

  assert.deepEqual(canonical, {
    version: 2,
    trendFixedLot: 0.12,
    sidewayRiskPercent: 0.4,
    sidewayMaxLot: 0.3,
    trendFixedTpEnabled: true,
    trendFixedTpDistance: 8,
    sidewayFixedTpEnabled: true,
    sidewayFixedTpDistance: 6.5,
  }, "RED_TARGET: PowerShell risk-profile validation must preserve independent Fixed TP settings.");
});

test("PowerShell v2 rejects enabled non-positive or non-finite Fixed TP distances", () => {
  for (const distance of [0, -1, "NaN", "Infinity"]) {
    const result = runRiskProfile({
      version: 2,
      trendFixedLot: 0.03,
      sidewayRiskPercent: 0.25,
      sidewayMaxLot: 0.03,
      trendFixedTpEnabled: true,
      trendFixedTpDistance: distance,
      sidewayFixedTpEnabled: false,
      sidewayFixedTpDistance: 0,
    });
    assert.notEqual(result.status, 0, `enabled Trend Fixed TP distance=${distance} must fail closed`);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /Trend fixed TP distance.*positive|Fixed TP.*positive/i,
      `distance=${distance} must fail for the Fixed TP distance contract`,
    );
  }
});

test("PowerShell migration preserves existing lot/risk and 0.03 increment guards", () => {
  for (const profile of [
    { version: 1, trendFixedLot: 0.05, sidewayRiskPercent: 0.25, sidewayMaxLot: 0.03 },
    { version: 2, trendFixedLot: 0.03, sidewayRiskPercent: 1.01, sidewayMaxLot: 0.03 },
    { version: 2, trendFixedLot: 0.03, sidewayRiskPercent: 0.25, sidewayMaxLot: 0.05 },
  ]) {
    const result = runRiskProfile(profile);
    assert.notEqual(result.status, 0, `invalid legacy risk contract must remain rejected: ${JSON.stringify(profile)}`);
  }
});
