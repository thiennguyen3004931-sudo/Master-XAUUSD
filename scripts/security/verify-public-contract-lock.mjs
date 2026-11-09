import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const PUBLIC_REPOSITORY = "thiennguyen3004931-sudo/xauusd-ai-master";
export const GOVERNED_PACKAGE_PATHS = Object.freeze([
  "packages/copy-protocol",
  "packages/license-service",
  "packages/installation-proof",
]);

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

function assertPlainObject(value, marker) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(marker);
  }
}

function assertExactPackageSet(packages) {
  assertPlainObject(packages, "PUBLIC_CONTRACT_PACKAGES_INVALID");
  const actual = Object.keys(packages).sort();
  const expected = [...GOVERNED_PACKAGE_PATHS].sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error("PUBLIC_CONTRACT_PACKAGE_SET_MISMATCH");
  }
}

export function validatePublicContractLock(lock) {
  assertPlainObject(lock, "PUBLIC_CONTRACT_LOCK_INVALID");

  if (lock.version !== 1) {
    throw new Error("PUBLIC_CONTRACT_VERSION_UNSUPPORTED");
  }
  if (lock.publicRepository !== PUBLIC_REPOSITORY) {
    throw new Error("PUBLIC_CONTRACT_REPOSITORY_MISMATCH");
  }
  if (typeof lock.publicCommit !== "string" || !FULL_SHA_RE.test(lock.publicCommit)) {
    throw new Error("PUBLIC_CONTRACT_COMMIT_INVALID");
  }

  assertExactPackageSet(lock.packages);
  for (const packagePath of GOVERNED_PACKAGE_PATHS) {
    const tree = lock.packages[packagePath];
    if (typeof tree !== "string" || !FULL_SHA_RE.test(tree)) {
      throw new Error(`PUBLIC_CONTRACT_TREE_INVALID:${packagePath}`);
    }
  }

  return lock;
}

export function comparePackageTrees(expectedTrees, actualTrees) {
  assertPlainObject(expectedTrees, "PUBLIC_CONTRACT_EXPECTED_TREES_INVALID");
  assertPlainObject(actualTrees, "PUBLIC_CONTRACT_ACTUAL_TREES_INVALID");

  const paths = [...new Set([...Object.keys(expectedTrees), ...Object.keys(actualTrees)])].sort();
  for (const packagePath of paths) {
    if (expectedTrees[packagePath] !== actualTrees[packagePath]) {
      throw new Error(`PUBLIC_CONTRACT_DRIFT:${packagePath}`);
    }
  }
}

export function resolvePackageTrees(commitish) {
  if (typeof commitish !== "string" || commitish.length === 0) {
    throw new Error("PUBLIC_CONTRACT_COMMITISH_REQUIRED");
  }

  return Object.fromEntries(
    GOVERNED_PACKAGE_PATHS.map((packagePath) => {
      try {
        const tree = execFileSync(
          "git",
          ["rev-parse", `${commitish}:${packagePath}`],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ).trim();
        if (!FULL_SHA_RE.test(tree)) {
          throw new Error("invalid tree id");
        }
        return [packagePath, tree];
      } catch {
        throw new Error(`PUBLIC_CONTRACT_GIT_OBJECT_ERROR:${packagePath}`);
      }
    }),
  );
}

export function verifyPublicContractLock(lock) {
  validatePublicContractLock(lock);

  const fetchedPublicTrees = resolvePackageTrees(lock.publicCommit);
  comparePackageTrees(lock.packages, fetchedPublicTrees);

  const privateHeadTrees = resolvePackageTrees("HEAD");
  comparePackageTrees(fetchedPublicTrees, privateHeadTrees);

  return {
    publicCommit: lock.publicCommit,
    packageTrees: fetchedPublicTrees,
  };
}

function main() {
  const lockPath = process.argv[2] ?? "security/public-contract.lock.json";
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    throw new Error("PUBLIC_CONTRACT_LOCK_READ_FAILED");
  }

  const result = verifyPublicContractLock(lock);
  console.log(`PUBLIC_CONTRACT_REPOSITORY=${PUBLIC_REPOSITORY}`);
  console.log(`PUBLIC_CONTRACT_COMMIT=${result.publicCommit}`);
  console.log(`PUBLIC_CONTRACT_PACKAGE_COUNT=${GOVERNED_PACKAGE_PATHS.length}`);
  console.log("PUBLIC_CONTRACT_LOCK=PASS");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
