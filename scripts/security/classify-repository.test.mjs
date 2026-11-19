import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyPath,
  classifyTrackedPaths,
} from "./classify-repository.mjs";
import {
  evaluateNameStatusEntries,
  evaluatePolicyChangeIsolation,
} from "./check-public-change-freeze.mjs";

test("known public and private responsibilities classify deterministically", () => {
  assert.equal(classifyPath("packages/copy-protocol/src/index.ts"), "SAFE_PUBLIC");
  assert.equal(classifyPath("packages/license-service/src/index.ts"), "SAFE_PUBLIC");
  assert.equal(classifyPath("packages/installation-proof/src/challenge.ts"), "SAFE_PUBLIC");
  assert.equal(classifyPath("packages/strategy-engine/src/index.ts"), "PRIVATE_REQUIRED");
  assert.equal(classifyPath("packages/risk-engine/src/index.ts"), "PRIVATE_REQUIRED");
  assert.equal(classifyPath("apps/api/src/index.ts"), "PRIVATE_REQUIRED");
});

test("unknown paths fail closed as PRIVATE_REQUIRED", () => {
  assert.equal(classifyPath("future/unknown-module/index.ts"), "PRIVATE_REQUIRED");
  assert.equal(classifyPath("scripts/new-master-controller.mjs"), "PRIVATE_REQUIRED");
});

test("only exact security governance files are public-safe", () => {
  assert.equal(classifyPath("security/repository-boundary.json"), "SAFE_PUBLIC");
  assert.equal(classifyPath("scripts/security/classify-repository.mjs"), "SAFE_PUBLIC");
  assert.equal(classifyPath("scripts/security/unapproved-new-script.mjs"), "PRIVATE_REQUIRED");
});

test("approved M1 M4 M6 M7 governance files are pre-authorized exactly", () => {
  const approved = [
    "security/credential-remediation.json",
    "scripts/security/validate-credential-remediation.mjs",
    "scripts/security/validate-credential-remediation.test.mjs",
    "scripts/security/check-public-boundary.mjs",
    "scripts/security/check-public-boundary.test.mjs",
    "scripts/security/check-distribution-artifact.mjs",
    "scripts/security/check-distribution-artifact.test.mjs",
    ".github/workflows/public-distribution-ci.yml",
    "scripts/security/accept-public-private-split.mjs",
  ];
  for (const path of approved) {
    assert.equal(classifyPath(path), "SAFE_PUBLIC", path);
  }
  assert.equal(
    classifyPath("scripts/security/future-unapproved-governance.mjs"),
    "PRIVATE_REQUIRED",
  );
});

test("tracked inventory returns deterministic counts", () => {
  const report = classifyTrackedPaths([
    "packages/copy-protocol/src/index.ts",
    "packages/strategy-engine/src/index.ts",
    "future/unknown-module/index.ts",
  ]);

  assert.deepEqual(report, {
    SAFE_PUBLIC: ["packages/copy-protocol/src/index.ts"],
    PRIVATE_REQUIRED: [
      "future/unknown-module/index.ts",
      "packages/strategy-engine/src/index.ts",
    ],
  });
});

test("freeze allows deletion of private source but blocks additions and modifications", () => {
  const result = evaluateNameStatusEntries([
    { status: "D", path: "packages/strategy-engine/src/old.ts" },
    { status: "M", path: "packages/strategy-engine/src/live.ts" },
    { status: "A", path: "apps/api/src/new-private.ts" },
    { status: "M", path: "packages/copy-protocol/src/index.ts" },
  ]);

  assert.deepEqual(result.allowed, [
    { status: "D", path: "packages/strategy-engine/src/old.ts" },
    { status: "M", path: "packages/copy-protocol/src/index.ts" },
  ]);
  assert.deepEqual(result.blocked, [
    { status: "M", path: "packages/strategy-engine/src/live.ts" },
    { status: "A", path: "apps/api/src/new-private.ts" },
  ]);
});

test("freeze treats rename into a private destination as blocked", () => {
  const result = evaluateNameStatusEntries([
    {
      status: "R100",
      path: "packages/copy-protocol/src/old.ts",
      newPath: "packages/strategy-engine/src/copied.ts",
    },
  ]);

  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].newPath, "packages/strategy-engine/src/copied.ts");
});

test("existing boundary policy may only change in an isolated policy PR", () => {
  const mixed = evaluatePolicyChangeIsolation(
    [
      { status: "M", path: "security/repository-boundary.json" },
      { status: "M", path: "packages/copy-protocol/src/index.ts" },
    ],
    { basePolicyPresent: true },
  );
  assert.equal(mixed.ok, false);
  assert.equal(mixed.code, "BOUNDARY_POLICY_CHANGE_MUST_BE_ISOLATED");

  const isolated = evaluatePolicyChangeIsolation(
    [{ status: "M", path: "security/repository-boundary.json" }],
    { basePolicyPresent: true },
  );
  assert.deepEqual(isolated, { ok: true });
});

test("bootstrap commit may introduce the initial policy with its governance files", () => {
  const bootstrap = evaluatePolicyChangeIsolation(
    [
      { status: "A", path: "security/repository-boundary.json" },
      { status: "A", path: "scripts/security/classify-repository.mjs" },
    ],
    { basePolicyPresent: false },
  );
  assert.deepEqual(bootstrap, { ok: true });
});
