import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const runnerPath = resolve(here, "run-phase7b-api-runtime-local.ps1");
const source = readFileSync(runnerPath, "utf8");

assert.match(
  source,
  /&\s+pnpm\s+build\s+['"]?--filter=@xauusd\/api\.\.\.['"]?/,
  "Phase7B API runtime must build @xauusd/api together with its workspace dependencies before start.",
);

assert.doesNotMatch(
  source,
  /&\s+pnpm\s+--filter\s+['"]@xauusd\/api['"]\s+build/,
  "Phase7B API runtime must not use the stale-dependency API-only build command.",
);

console.log("PHASE7B_API_RUNTIME_DEPENDENCY_BUILD_SOURCE_CONTRACT=PASS");
