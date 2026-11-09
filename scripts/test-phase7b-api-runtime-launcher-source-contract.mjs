import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const launcherPath = process.argv[2] ?? join(here, "run-phase7b-api-runtime-local.ps1");

function fail(reason) {
  console.error("PHASE7B_API_RUNTIME_LAUNCHER_SOURCE_CONTRACT=FAIL");
  console.error(`REASON=${reason}`);
  process.exit(1);
}

let launcher;
try {
  launcher = readFileSync(launcherPath, "utf8");
} catch {
  fail("LAUNCHER_NOT_FOUND");
}

const devPattern = /^\s*&?\s*pnpm\s+--filter\s+['"]?@xauusd\/api['"]?\s+dev(?:\s|$)/im;
const tsxWatchPattern = /\btsx\s+watch\b/i;
const buildPattern = /^\s*&?\s*pnpm\s+--filter\s+['"]?@xauusd\/api['"]?\s+build(?:\s|$)/im;
const startPattern = /^\s*&?\s*pnpm\s+--filter\s+['"]?@xauusd\/api['"]?\s+start(?:\s|$)/im;

if (devPattern.test(launcher)) {
  fail("FORBIDDEN_API_DEV_COMMAND_PRESENT");
}

if (tsxWatchPattern.test(launcher)) {
  fail("FORBIDDEN_TSX_WATCH_PRESENT");
}

const buildMatch = buildPattern.exec(launcher);
const startMatch = startPattern.exec(launcher);

if (!buildMatch) {
  fail("PRODUCTION_BUILD_COMMAND_MISSING");
}

if (!startMatch) {
  fail("PRODUCTION_START_COMMAND_MISSING");
}

if (buildMatch.index >= startMatch.index) {
  fail("PRODUCTION_BUILD_MUST_PRECEDE_START");
}

console.log("PHASE7B_API_RUNTIME_LAUNCHER_SOURCE_CONTRACT=PASS");
process.exit(0);
