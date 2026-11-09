import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PUBLIC_REPOSITORY = "thiennguyen3004931-sudo/xauusd-ai-master";
export const PRIVATE_REPOSITORY = "thiennguyen3004931-sudo/xauusd-ai-master-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const SHA_RE = /^[0-9a-f]{40}$/i;

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}_MISSING`);
  }
  return value.trim();
}

function requireSha(value, label) {
  const normalized = requireString(value, label);
  if (!SHA_RE.test(normalized)) {
    throw new Error(`${label}_INVALID`);
  }
  return normalized.toLowerCase();
}

export function verifyBootstrap(attestation) {
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) {
    throw new Error("BOOTSTRAP_ATTESTATION_INVALID");
  }

  if (attestation.version !== 1) {
    throw new Error("BOOTSTRAP_ATTESTATION_VERSION_UNSUPPORTED");
  }

  if (attestation.publicRepository !== PUBLIC_REPOSITORY) {
    throw new Error("PUBLIC_REPOSITORY_MISMATCH");
  }

  if (attestation.privateRepository !== PRIVATE_REPOSITORY) {
    throw new Error("PRIVATE_REPOSITORY_MISMATCH");
  }

  const publicCommit = requireSha(attestation.publicCommit, "PUBLIC_COMMIT");
  const privateBootstrapCommit = requireSha(
    attestation.privateBootstrapCommit,
    "PRIVATE_BOOTSTRAP_COMMIT",
  );
  const publicTree = requireSha(attestation.publicTree, "PUBLIC_TREE");
  const privateBootstrapTree = requireSha(
    attestation.privateBootstrapTree,
    "PRIVATE_BOOTSTRAP_TREE",
  );

  if (publicCommit !== privateBootstrapCommit) {
    throw new Error("BOOTSTRAP_COMMIT_MISMATCH");
  }

  if (publicTree !== privateBootstrapTree) {
    throw new Error("BOOTSTRAP_TREE_MISMATCH");
  }

  requireString(attestation.importMethod, "IMPORT_METHOD");
  requireString(attestation.operator, "OPERATOR");

  const recordedAt = requireString(attestation.recordedAt, "RECORDED_AT");
  if (Number.isNaN(Date.parse(recordedAt))) {
    throw new Error("RECORDED_AT_INVALID");
  }

  return true;
}

export function verifyBootstrapAgainstRepository(
  attestation,
  cwd = repoRoot,
  { targetRepository = process.env.GITHUB_REPOSITORY } = {},
) {
  verifyBootstrap(attestation);

  // A valid legacy attestation must not be re-used to approve a different
  // GitHub repository. This is a fail-closed check, not a migration mechanism.
  if (targetRepository !== undefined &&
      (typeof targetRepository !== "string" ||
       attestation.privateRepository.toLowerCase() !== targetRepository.toLowerCase())) {
    throw new Error("PRIVATE_BOOTSTRAP_TARGET_REPOSITORY_MISMATCH");
  }

  const actualTree = execFileSync(
    "git",
    ["rev-parse", `${attestation.privateBootstrapCommit}^{tree}`],
    { cwd, encoding: "utf8" },
  )
    .trim()
    .toLowerCase();

  if (actualTree !== attestation.privateBootstrapTree.toLowerCase()) {
    throw new Error("PRIVATE_BOOTSTRAP_GIT_TREE_MISMATCH");
  }

  try {
    execFileSync(
      "git",
      ["merge-base", "--is-ancestor", attestation.privateBootstrapCommit, "HEAD"],
      { cwd, stdio: "ignore" },
    );
  } catch {
    throw new Error("PRIVATE_BOOTSTRAP_NOT_ANCESTOR");
  }

  return true;
}

function resolveAttestationPath(input) {
  if (!input) {
    throw new Error("USAGE: node scripts/security/verify-private-bootstrap.mjs <attestation.json>");
  }
  return path.isAbsolute(input) ? input : path.resolve(repoRoot, input);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const attestationPath = resolveAttestationPath(process.argv[2]);
    const attestation = JSON.parse(fs.readFileSync(attestationPath, "utf8"));
    verifyBootstrapAgainstRepository(attestation);
    console.log("PRIVATE_BOOTSTRAP_ATTESTATION=PASS");
  } catch (error) {
    console.error(`PRIVATE_BOOTSTRAP_ATTESTATION=FAIL:${error.message}`);
    process.exitCode = 1;
  }
}
