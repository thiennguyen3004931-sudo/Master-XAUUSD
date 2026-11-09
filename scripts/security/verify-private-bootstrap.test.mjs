import test from "node:test";
import assert from "node:assert/strict";
import { buildBootstrapAttestation } from "./write-private-bootstrap-attestation.mjs";
import { verifyBootstrap, verifyBootstrapAgainstRepository } from "./verify-private-bootstrap.mjs";

const PUBLIC_REPOSITORY = "thiennguyen3004931-sudo/xauusd-ai-master";
const PRIVATE_REPOSITORY = "thiennguyen3004931-sudo/xauusd-ai-master-core";
const COMMIT = "de777c713da0bf4dd6d1c562898846dad1b82f3b";
const TREE = "2527080bafe962a7ad69bf27fcc5263f103971ab";

function validAttestation(overrides = {}) {
  return {
    version: 1,
    publicRepository: PUBLIC_REPOSITORY,
    publicCommit: COMMIT,
    publicTree: TREE,
    privateRepository: PRIVATE_REPOSITORY,
    privateBootstrapCommit: COMMIT,
    privateBootstrapTree: TREE,
    importMethod: "verified-identical-public-private-commit-tree",
    recordedAt: "2026-09-16T01:16:31Z",
    operator: "thiennguyen3004931-sudo",
    ...overrides,
  };
}

test("different bootstrap trees are rejected", () => {
  assert.throws(
    () => verifyBootstrap(validAttestation({ privateBootstrapTree: "1".repeat(40) })),
    /BOOTSTRAP_TREE_MISMATCH/,
  );
});

test("different bootstrap commits are rejected", () => {
  assert.throws(
    () => verifyBootstrap(validAttestation({ privateBootstrapCommit: "2".repeat(40) })),
    /BOOTSTRAP_COMMIT_MISMATCH/,
  );
});

test("repository identity is fail closed", () => {
  assert.throws(
    () => verifyBootstrap(validAttestation({ privateRepository: PUBLIC_REPOSITORY })),
    /PRIVATE_REPOSITORY_MISMATCH/,
  );
});

test("canonical bootstrap attestation is accepted", () => {
  assert.equal(verifyBootstrap(validAttestation()), true);
});

test("M2 provenance cannot authorize another GitHub target repository", () => {
  assert.throws(
    () => verifyBootstrapAgainstRepository(
      validAttestation(),
      process.cwd(),
      { targetRepository: "thiennguyen3004931-sudo/Master-XAUUSD" },
    ),
    /PRIVATE_BOOTSTRAP_TARGET_REPOSITORY_MISMATCH/,
  );
});

test("M2 target repository name comparison is case-insensitive and never substitutes Git history", () => {
  // Matching the name proceeds to Git object/ancestor verification. It must
  // never itself be treated as proof of a valid bootstrap.
  assert.throws(
    () => verifyBootstrapAgainstRepository(
      validAttestation(),
      process.cwd() + "/definitely-not-a-git-repository",
      { targetRepository: "THIENNGUYEN3004931-SUDO/XAUUSD-AI-MASTER-CORE" },
    ),
    /Command failed|ENOENT|spawn|not a git repository|cannot change to/,
  );
});

test("writer refuses non-identical source and bootstrap git objects", () => {
  assert.throws(
    () =>
      buildBootstrapAttestation({
        publicCommit: COMMIT,
        publicTree: TREE,
        privateBootstrapCommit: COMMIT,
        privateBootstrapTree: "3".repeat(40),
        recordedAt: "2026-09-16T01:16:31Z",
        operator: "thiennguyen3004931-sudo",
      }),
    /BOOTSTRAP_TREE_MISMATCH/,
  );
});
