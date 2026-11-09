import test from "node:test";
import assert from "node:assert/strict";
import {
  PUBLIC_REPOSITORY,
  GOVERNED_PACKAGE_PATHS,
  comparePackageTrees,
  validatePublicContractLock,
} from "./verify-public-contract-lock.mjs";
import { buildPublicContractLock } from "./write-public-contract-lock.mjs";

const PUBLIC_COMMIT = "1a54fe559ed06f04fe7f80bc276aee6f13a5c054";
const TREES = {
  "packages/copy-protocol": "1111111111111111111111111111111111111111",
  "packages/license-service": "2222222222222222222222222222222222222222",
  "packages/installation-proof": "3333333333333333333333333333333333333333",
};

function validLock(overrides = {}) {
  return {
    version: 1,
    publicRepository: PUBLIC_REPOSITORY,
    publicCommit: PUBLIC_COMMIT,
    packages: { ...TREES },
    ...overrides,
  };
}

test("M6 governs exactly the three approved public contract packages", () => {
  assert.deepEqual(GOVERNED_PACKAGE_PATHS, [
    "packages/copy-protocol",
    "packages/license-service",
    "packages/installation-proof",
  ]);
});

test("contract drift fails closed", () => {
  assert.throws(
    () => comparePackageTrees(
      { "packages/copy-protocol": "aaa" },
      { "packages/copy-protocol": "bbb" },
    ),
    /PUBLIC_CONTRACT_DRIFT:packages\/copy-protocol/,
  );
});

test("exact public package trees are accepted", () => {
  assert.doesNotThrow(() => comparePackageTrees(TREES, { ...TREES }));
});

test("lock repository identity is fail closed", () => {
  assert.throws(
    () => validatePublicContractLock(validLock({ publicRepository: "example/other" })),
    /PUBLIC_CONTRACT_REPOSITORY_MISMATCH/,
  );
});

test("lock rejects missing or extra governed packages", () => {
  const missing = { ...TREES };
  delete missing["packages/license-service"];
  assert.throws(
    () => validatePublicContractLock(validLock({ packages: missing })),
    /PUBLIC_CONTRACT_PACKAGE_SET_MISMATCH/,
  );

  assert.throws(
    () => validatePublicContractLock(validLock({ packages: { ...TREES, "packages/extra": "4".repeat(40) } })),
    /PUBLIC_CONTRACT_PACKAGE_SET_MISMATCH/,
  );
});

test("lock rejects malformed commit and tree ids", () => {
  assert.throws(
    () => validatePublicContractLock(validLock({ publicCommit: "not-a-sha" })),
    /PUBLIC_CONTRACT_COMMIT_INVALID/,
  );
  assert.throws(
    () => validatePublicContractLock(validLock({ packages: { ...TREES, "packages/copy-protocol": "bad" } })),
    /PUBLIC_CONTRACT_TREE_INVALID:packages\/copy-protocol/,
  );
});

test("writer builds deterministic lock content from supplied Git-derived trees", () => {
  assert.deepEqual(
    buildPublicContractLock({ publicCommit: PUBLIC_COMMIT, packageTrees: TREES }),
    validLock(),
  );
});
