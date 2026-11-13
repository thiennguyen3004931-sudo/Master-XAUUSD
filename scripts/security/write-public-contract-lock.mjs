import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  PUBLIC_REPOSITORY,
  GOVERNED_PACKAGE_PATHS,
  validatePublicContractLock,
} from "./verify-public-contract-lock.mjs";

export function buildPublicContractLock({ publicCommit, packageTrees }) {
  const lock = {
    version: 1,
    publicRepository: PUBLIC_REPOSITORY,
    publicCommit,
    packages: Object.fromEntries(
      GOVERNED_PACKAGE_PATHS.map((packagePath) => [packagePath, packageTrees?.[packagePath]]),
    ),
  };
  validatePublicContractLock(lock);
  return lock;
}

function resolvePackageTrees(publicCommit) {
  return Object.fromEntries(
    GOVERNED_PACKAGE_PATHS.map((packagePath) => {
      let tree;
      try {
        tree = execFileSync(
          "git",
          ["rev-parse", `${publicCommit}:${packagePath}`],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ).trim();
      } catch {
        throw new Error(`PUBLIC_CONTRACT_GIT_OBJECT_ERROR:${packagePath}`);
      }
      return [packagePath, tree];
    }),
  );
}

function main() {
  const publicCommit = process.argv[2];
  const outputPath = process.argv[3] ?? "security/public-contract.lock.json";
  if (!publicCommit) {
    throw new Error("PUBLIC_COMMIT_REQUIRED");
  }

  const packageTrees = resolvePackageTrees(publicCommit);
  const lock = buildPublicContractLock({ publicCommit, packageTrees });
  writeFileSync(outputPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  console.log(`PUBLIC_CONTRACT_COMMIT=${lock.publicCommit}`);
  console.log(`PUBLIC_CONTRACT_PACKAGE_COUNT=${GOVERNED_PACKAGE_PATHS.length}`);
  console.log(`PUBLIC_CONTRACT_LOCK_WRITTEN=${outputPath}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
