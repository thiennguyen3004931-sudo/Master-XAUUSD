import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GOVERNED_PACKAGE_PATHS,
  verifyPublicContractLock,
} from "./verify-public-contract-lock.mjs";
import {
  inspectTrackedContent,
  inspectTrackedPath,
} from "./check-private-secrets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC_PACKAGES = new Set([
  "@xauusd/copy-protocol",
  "@xauusd/license-service",
  "@xauusd/installation-proof",
]);
const TEXT_EXTENSIONS = new Set([
  ".cjs", ".js", ".json", ".jsx", ".mjs", ".mts", ".ts", ".tsx", ".yaml", ".yml",
]);
const REQUIRED_GREEN = Object.freeze({
  PRIVATE_BUILD: "PASS",
  MASTER_REGRESSION: "PASS",
  PUBLIC_CONTRACT_LOCK: "PASS",
  PRIVATE_SIGNING_KEY_TRACKED: "FALSE",
  PRIVATE_DEPENDS_ON_PUBLIC_CONTRACTS: "TRUE",
  PUBLIC_DEPENDS_ON_PRIVATE_SOURCE: "FALSE",
  PRODUCTION_CUTOVER: "NOT_PERFORMED",
});

export function evaluateMasterCoreAcceptance({
  buildPassed,
  masterRegressionPassed,
  publicContractLockPassed,
  privateSigningKeyTracked,
  privateDependsOnPublicContracts,
  publicDependsOnPrivateSource,
  productionCutoverPerformed,
}) {
  return {
    PRIVATE_BUILD: buildPassed ? "PASS" : "FAIL",
    MASTER_REGRESSION: masterRegressionPassed ? "PASS" : "FAIL",
    PUBLIC_CONTRACT_LOCK: publicContractLockPassed ? "PASS" : "FAIL",
    PRIVATE_SIGNING_KEY_TRACKED: privateSigningKeyTracked ? "TRUE" : "FALSE",
    PRIVATE_DEPENDS_ON_PUBLIC_CONTRACTS: privateDependsOnPublicContracts ? "TRUE" : "FALSE",
    PUBLIC_DEPENDS_ON_PRIVATE_SOURCE: publicDependsOnPrivateSource ? "TRUE" : "FALSE",
    PRODUCTION_CUTOVER: productionCutoverPerformed ? "PERFORMED" : "NOT_PERFORMED",
  };
}

export function assertMasterCoreAcceptance(verdicts) {
  for (const [key, expected] of Object.entries(REQUIRED_GREEN)) {
    if (verdicts[key] !== expected) {
      throw new Error(`M7_PRIVATE_ACCEPTANCE_FAILED:${key}=${verdicts[key]}`);
    }
  }
}

function trackedPaths() {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
}

function isTextPath(filePath) {
  const base = path.basename(filePath);
  return base === "package.json" || TEXT_EXTENSIONS.has(path.extname(base).toLowerCase());
}

function trackedSecretPresent(paths) {
  for (const filePath of paths) {
    if (inspectTrackedPath(filePath) === "REJECT") return true;
    if (!isTextPath(filePath)) continue;
    const content = fs.readFileSync(path.join(repoRoot, filePath), "utf8");
    if (inspectTrackedContent(filePath, content) === "REJECT") return true;
  }
  return false;
}

function publicContractDependencyEvidence(paths) {
  return paths.some((filePath) => {
    const isPrivateRuntimePath = filePath.startsWith("apps/") || filePath.startsWith("packages/");
    if (!isPrivateRuntimePath || !isTextPath(filePath)) return false;
    if (GOVERNED_PACKAGE_PATHS.some((prefix) => filePath.startsWith(`${prefix}/`))) return false;
    const text = fs.readFileSync(path.join(repoRoot, filePath), "utf8");
    return [...PUBLIC_PACKAGES].some((packageName) => text.includes(packageName));
  });
}

export function hasPublicContractDependencyEvidence({
  publicContractLockVerified,
  directReferencePresent,
}) {
  return publicContractLockVerified === true || directReferencePresent === true;
}

function governedPublicDependsOnPrivateSource(paths) {
  const governedPaths = paths.filter((filePath) =>
    GOVERNED_PACKAGE_PATHS.some((prefix) => filePath.startsWith(`${prefix}/`)),
  );

  for (const filePath of governedPaths) {
    if (!isTextPath(filePath)) continue;
    const text = fs.readFileSync(path.join(repoRoot, filePath), "utf8");
    for (const match of text.matchAll(/@xauusd\/[A-Za-z0-9._-]+/g)) {
      if (!PUBLIC_PACKAGES.has(match[0])) return true;
    }
    if (/(?:\.\.\/)+(?:apps|packages\/(?:strategy|signal|decision|trade|risk|analytics|orchestration))\//i.test(text)) {
      return true;
    }
  }
  return false;
}

function verifyContractLockFromSource() {
  try {
    const lock = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "security/public-contract.lock.json"), "utf8"),
    );
    verifyPublicContractLock(lock);
    return true;
  } catch {
    return false;
  }
}

export function collectMasterCoreAcceptanceEvidence(env = process.env) {
  const paths = trackedPaths();
  const productionCutover = env.M7_PRODUCTION_CUTOVER ?? "";
  const publicContractLockVerified = verifyContractLockFromSource();
  return {
    buildPassed: env.M7_PRIVATE_BUILD_OUTCOME === "success",
    masterRegressionPassed: env.M7_MASTER_REGRESSION_OUTCOME === "success",
    publicContractLockPassed:
      env.M7_PUBLIC_CONTRACT_OUTCOME === "success" && publicContractLockVerified,
    privateSigningKeyTracked: trackedSecretPresent(paths),
    privateDependsOnPublicContracts: hasPublicContractDependencyEvidence({
      publicContractLockVerified,
      directReferencePresent: publicContractDependencyEvidence(paths),
    }),
    publicDependsOnPrivateSource: governedPublicDependsOnPrivateSource(paths),
    productionCutoverPerformed: productionCutover !== "NOT_PERFORMED",
  };
}

function printVerdicts(verdicts) {
  for (const key of Object.keys(REQUIRED_GREEN)) {
    console.log(`${key}=${verdicts[key]}`);
  }
  console.log("M7_PRIVATE_ACCEPTANCE=PASS");
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    const verdicts = evaluateMasterCoreAcceptance(collectMasterCoreAcceptanceEvidence());
    assertMasterCoreAcceptance(verdicts);
    printVerdicts(verdicts);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
