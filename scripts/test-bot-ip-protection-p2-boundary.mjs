import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const packageDir = path.join(root, "packages", "license-service");
const sourceDir = path.join(packageDir, "src");
const workflowPath = path.join(
  root,
  ".github",
  "workflows",
  "bot-ip-protection-p2-license-service-ci.yml"
);

async function listFilesRecursively(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

test("license service runtime dependency is exactly copy-protocol", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(packageDir, "package.json"), "utf8")
  );
  assert.equal(packageJson.name, "@xauusd/license-service");

  const runtimeDependencies = Object.keys(packageJson.dependencies ?? {}).sort();
  assert.deepEqual(runtimeDependencies, ["@xauusd/copy-protocol"]);
});

test("license service contains no proprietary strategy or execution dependency", async () => {
  const files = await listFilesRecursively(sourceDir);
  const forbidden = [
    "@xauusd/strategy-engine",
    "@xauusd/risk-engine",
    "@xauusd/execution-engine",
    "@xauusd/mt5-broker",
    "run-phase7b",
    "run-phase7c",
    "BEGIN PRIVATE KEY"
  ];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const marker of forbidden) {
      assert.equal(
        content.includes(marker),
        false,
        `${path.relative(root, file)} contains forbidden marker: ${marker}`
      );
    }
  }
});

test("license service stays pure source logic with no persistence, network, or MT5 mutation path", async () => {
  const files = await listFilesRecursively(sourceDir);
  const forbiddenRuntimeMarkers = [
    'from "node:fs"',
    'from "node:fs/promises"',
    'from "node:net"',
    'from "node:http"',
    'from "node:https"',
    'from "express"',
    'from "axios"',
    "createServer(",
    "fetch(",
    "WebSocket",
    "node:sqlite",
    "better-sqlite3",
    "writeFile(",
    "appendFile(",
    "order_send",
    "position_modify",
    "position_close"
  ];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const marker of forbiddenRuntimeMarkers) {
      assert.equal(
        content.includes(marker),
        false,
        `${path.relative(root, file)} contains forbidden runtime marker: ${marker}`
      );
    }
  }
});

test("dedicated P2 workflow locks the complete security gate", async () => {
  assert.equal((await stat(workflowPath)).isFile(), true);
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /push:\s*\n\s*branches:/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm --filter @xauusd\/license-service test/);
  assert.match(workflow, /pnpm --filter @xauusd\/license-service typecheck/);
  assert.match(workflow, /pnpm --filter @xauusd\/license-service build/);
  assert.match(workflow, /node --test scripts\/test-bot-ip-protection-p2-boundary\.mjs/);
  assert.match(workflow, /git diff --check/);
});
