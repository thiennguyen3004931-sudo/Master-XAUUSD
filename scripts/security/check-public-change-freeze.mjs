import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyPath } from "./classify-repository.mjs";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const POLICY_PATH = "security/repository-boundary.json";

export function parseNameStatus(output) {
  const entries = [];
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    const status = fields[0];
    if (/^[RC]\d+$/.test(status)) {
      if (fields.length !== 3) throw new Error(`INVALID_RENAME_COPY_STATUS_LINE:${line}`);
      entries.push({ status, path: fields[1], newPath: fields[2] });
      continue;
    }
    if (fields.length !== 2) throw new Error(`INVALID_NAME_STATUS_LINE:${line}`);
    entries.push({ status, path: fields[1] });
  }
  return entries;
}

function touchesPrivate(entry) {
  const sourcePrivate = classifyPath(entry.path) === "PRIVATE_REQUIRED";
  const destinationPrivate = entry.newPath
    ? classifyPath(entry.newPath) === "PRIVATE_REQUIRED"
    : false;
  return sourcePrivate || destinationPrivate;
}

export function evaluateNameStatusEntries(entries) {
  const allowed = [];
  const blocked = [];

  for (const entry of entries) {
    const isDeletion = entry.status === "D";
    if (touchesPrivate(entry) && !isDeletion) {
      blocked.push(entry);
    } else {
      allowed.push(entry);
    }
  }

  return { allowed, blocked };
}

export function evaluatePolicyChangeIsolation(entries, { basePolicyPresent }) {
  if (!basePolicyPresent) return { ok: true };

  const policyChanged = entries.some(
    (entry) => entry.path === POLICY_PATH || entry.newPath === POLICY_PATH,
  );
  if (!policyChanged) return { ok: true };

  const mixedNonDeletionChange = entries.some((entry) => {
    const touchesPolicy = entry.path === POLICY_PATH || entry.newPath === POLICY_PATH;
    return !touchesPolicy && entry.status !== "D";
  });

  if (mixedNonDeletionChange) {
    return { ok: false, code: "BOUNDARY_POLICY_CHANGE_MUST_BE_ISOLATED" };
  }
  return { ok: true };
}

export function diffEntries(baseSha, headSha) {
  if (!baseSha || !headSha) throw new Error("BASE_AND_HEAD_SHA_REQUIRED");
  const output = execFileSync(
    "git",
    ["diff", "--name-status", "-M", "-C", `${baseSha}...${headSha}`],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return parseNameStatus(output);
}

export function basePolicyExistsAtCommit(baseSha) {
  try {
    execFileSync("git", ["cat-file", "-e", `${baseSha}:${POLICY_PATH}`], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const [baseSha, headSha] = process.argv.slice(2);
  if (!baseSha || !headSha) {
    console.error("USAGE: node scripts/security/check-public-change-freeze.mjs <baseSha> <headSha>");
    process.exitCode = 2;
    return;
  }

  const entries = diffEntries(baseSha, headSha);
  const policyIsolation = evaluatePolicyChangeIsolation(entries, {
    basePolicyPresent: basePolicyExistsAtCommit(baseSha),
  });
  if (!policyIsolation.ok) {
    console.error(`PUBLIC_PRIVATE_FREEZE=BLOCKED`);
    console.error(`REASON=${policyIsolation.code}`);
    process.exitCode = 1;
    return;
  }

  const result = evaluateNameStatusEntries(entries);
  if (result.blocked.length > 0) {
    console.error("PUBLIC_PRIVATE_FREEZE=BLOCKED");
    for (const entry of result.blocked) {
      const destination = entry.newPath ? ` -> ${entry.newPath}` : "";
      console.error(`${entry.status}\t${entry.path}${destination}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("PUBLIC_PRIVATE_FREEZE=PASS");
  console.log(`ALLOWED_CHANGE_COUNT=${result.allowed.length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
