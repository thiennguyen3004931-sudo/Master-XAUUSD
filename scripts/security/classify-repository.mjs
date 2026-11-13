import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const POLICY_PATH = resolve(REPO_ROOT, "security/repository-boundary.json");

function normalizePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

function loadPolicy() {
  const parsed = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
  if (parsed.version !== 1) {
    throw new Error(`UNSUPPORTED_BOUNDARY_POLICY_VERSION:${parsed.version}`);
  }
  if (parsed.defaultClassification !== "PRIVATE_REQUIRED") {
    throw new Error("BOUNDARY_POLICY_MUST_DEFAULT_PRIVATE");
  }
  if (!Array.isArray(parsed.safePublicPrefixes) || !Array.isArray(parsed.safePublicExact)) {
    throw new Error("INVALID_BOUNDARY_POLICY");
  }
  return parsed;
}

const POLICY = loadPolicy();
const SAFE_EXACT = new Set(POLICY.safePublicExact.map(normalizePath));
const SAFE_PREFIXES = POLICY.safePublicPrefixes.map(normalizePath);

export function classifyPath(inputPath) {
  const path = normalizePath(inputPath);
  if (SAFE_EXACT.has(path)) return "SAFE_PUBLIC";
  if (SAFE_PREFIXES.some((prefix) => path.startsWith(prefix))) return "SAFE_PUBLIC";
  return "PRIVATE_REQUIRED";
}

export function classifyTrackedPaths(paths) {
  const report = {
    SAFE_PUBLIC: [],
    PRIVATE_REQUIRED: [],
  };

  for (const rawPath of paths) {
    const path = normalizePath(rawPath);
    if (!path) continue;
    report[classifyPath(path)].push(path);
  }

  report.SAFE_PUBLIC.sort();
  report.PRIVATE_REQUIRED.sort();
  return report;
}

export function trackedPathsFromGit() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean);
}

function main() {
  if (!process.argv.includes("--tracked")) {
    console.error("USAGE: node scripts/security/classify-repository.mjs --tracked");
    process.exitCode = 2;
    return;
  }

  const report = classifyTrackedPaths(trackedPathsFromGit());
  console.log(`SAFE_PUBLIC_COUNT=${report.SAFE_PUBLIC.length}`);
  console.log(`PRIVATE_REQUIRED_COUNT=${report.PRIVATE_REQUIRED.length}`);
  console.log("UNCLASSIFIED_COUNT=0");
  console.log("DEFAULT_CLASSIFICATION=PRIVATE_REQUIRED");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
