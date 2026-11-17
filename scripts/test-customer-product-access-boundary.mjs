import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const packageDir = path.join(root, "packages", "customer-product-access");
const sourceDir = path.join(packageDir, "src");
const workflowPath = path.join(
  root,
  ".github",
  "workflows",
  "customer-product-access-ci.yml"
);

async function listFilesRecursively(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFilesRecursively(fullPath)));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

test("customer product access depends only on the public license contract", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(packageDir, "package.json"), "utf8")
  );
  assert.equal(packageJson.name, "@xauusd/customer-product-access");
  assert.deepEqual(
    Object.keys(packageJson.dependencies ?? {}).sort(),
    ["@xauusd/license-service"]
  );
});

test("customer product access contains no proprietary strategy or execution dependency", async () => {
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

test("customer product access remains pure authorization logic", async () => {
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

test("dedicated customer product access CI locks the private boundary", async () => {
  assert.equal((await stat(workflowPath)).isFile(), true);
  const workflow = await readFile(workflowPath, "utf8");
  for (const required of [
    "permissions:",
    "contents: read",
    "pnpm install --frozen-lockfile",
    "pnpm --filter @xauusd/copy-protocol build",
    "pnpm --filter @xauusd/license-service build",
    "pnpm --filter @xauusd/customer-product-access test",
    "pnpm --filter @xauusd/customer-product-access typecheck",
    "pnpm --filter @xauusd/customer-product-access build",
    "node --test scripts/test-customer-product-access-boundary.mjs",
    "git diff --check"
  ]) {
    assert.ok(workflow.includes(required), `Customer access CI missing: ${required}`);
  }
});
