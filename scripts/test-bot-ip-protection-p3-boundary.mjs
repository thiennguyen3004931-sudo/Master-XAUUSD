import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PACKAGE_DIR = path.join(ROOT, "packages", "installation-proof");
const SRC_DIR = path.join(PACKAGE_DIR, "src");
const PACKAGE_JSON = path.join(PACKAGE_DIR, "package.json");
const WORKFLOW = path.join(
  ROOT,
  ".github",
  "workflows",
  "bot-ip-protection-p3-installation-proof-ci.yml",
);

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

const packageJson = JSON.parse(read(PACKAGE_JSON));
assert.deepEqual(
  Object.keys(packageJson.dependencies ?? {}).sort(),
  ["@xauusd/copy-protocol"],
  "P3 runtime dependency must stay exactly @xauusd/copy-protocol",
);

const runtimeSources = listFiles(SRC_DIR).filter(
  (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
);
assert.ok(
  runtimeSources.some((file) => path.basename(file) === "index.ts"),
  "P3 package must expose a public src/index.ts entrypoint",
);

const forbiddenPatterns = [
  /@xauusd\/strategy-engine/,
  /@xauusd\/risk-engine/,
  /@xauusd\/execution-engine/,
  /@xauusd\/mt5-broker/,
  /Phase7B|Phase7C/,
  /node:(?:fs|http|https|net|tls|dgram|child_process)/,
  /\b(?:fetch|WebSocket|createServer)\s*\(/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

for (const file of runtimeSources) {
  const source = read(file);
  for (const pattern of forbiddenPatterns) {
    assert.doesNotMatch(
      source,
      pattern,
      `P3 runtime boundary violation in ${path.relative(ROOT, file)}: ${pattern}`,
    );
  }
}

const workflow = read(WORKFLOW);
for (const required of [
  "pull_request:",
  "push:",
  "permissions:",
  "contents: read",
  "pnpm install --frozen-lockfile",
  "pnpm --filter @xauusd/copy-protocol build",
  "pnpm --filter @xauusd/installation-proof test",
  "pnpm --filter @xauusd/installation-proof typecheck",
  "pnpm --filter @xauusd/installation-proof build",
  "node --test scripts/test-bot-ip-protection-p3-boundary.mjs",
  "git diff --check",
]) {
  assert.ok(workflow.includes(required), `P3 CI missing required contract: ${required}`);
}
assert.ok(
  !workflow.includes("--no-frozen-lockfile"),
  "P3 final CI must not use non-frozen dependency installation",
);

console.log("BOT_IP_PROTECTION_P3_BOUNDARY=PASS");
console.log(`P3_RUNTIME_SOURCE_COUNT=${runtimeSources.length}`);
console.log("P3_PROPRIETARY_STRATEGY_DEPENDENCY=NONE");
console.log("P3_PERSISTENCE_NETWORK_MT5_MUTATION=NONE");
console.log("P3_PRIVATE_KEY_LITERAL=NONE");
