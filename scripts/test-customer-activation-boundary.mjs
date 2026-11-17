import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const packageDir = path.join(root, "packages", "customer-activation");
const sourceDir = path.join(packageDir, "src");
const workflowPath = path.join(
  root,
  ".github",
  "workflows",
  "customer-activation-ci.yml",
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

test("activation depends only on approved customer security contracts", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(packageDir, "package.json"), "utf8"),
  );
  assert.equal(packageJson.name, "@xauusd/customer-activation");
  assert.deepEqual(
    Object.keys(packageJson.dependencies ?? {}).sort(),
    [
      "@xauusd/customer-product-access",
      "@xauusd/installation-proof",
      "@xauusd/license-service",
    ],
  );
});

test("activation contains no strategy, risk, execution, or MT5 dependency", async () => {
  const files = await listFilesRecursively(sourceDir);
  const forbidden = [
    "@xauusd/strategy-engine",
    "@xauusd/risk-engine",
    "@xauusd/execution-engine",
    "@xauusd/mt5-broker",
    "order_send",
    "position_modify",
    "position_close",
    "BEGIN PRIVATE KEY",
  ];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const marker of forbidden) {
      assert.equal(
        content.includes(marker),
        false,
        `${path.relative(root, file)} contains forbidden marker: ${marker}`,
      );
    }
  }
});

test("activation contains no persistence or network implementation", async () => {
  const files = await listFilesRecursively(sourceDir);
  const forbidden = [
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
  ];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const marker of forbidden) {
      assert.equal(
        content.includes(marker),
        false,
        `${path.relative(root, file)} contains forbidden runtime marker: ${marker}`,
      );
    }
  }
});

test("dedicated activation CI locks the private boundary", async () => {
  assert.equal((await stat(workflowPath)).isFile(), true);
  const workflow = await readFile(workflowPath, "utf8");
  for (const required of [
    "permissions:",
    "contents: read",
    "pnpm install --frozen-lockfile",
    "pnpm --filter @xauusd/copy-protocol build",
    "pnpm --filter @xauusd/license-service build",
    "pnpm --filter @xauusd/customer-product-access build",
    "pnpm --filter @xauusd/installation-proof build",
    "pnpm --filter @xauusd/customer-activation test",
    "pnpm --filter @xauusd/customer-activation typecheck",
    "pnpm --filter @xauusd/customer-activation build",
    "node --test scripts/test-customer-activation-boundary.mjs",
    "git diff --check",
  ]) {
    assert.ok(workflow.includes(required), `Activation CI missing: ${required}`);
  }
});
