import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(root, "packages", "customer-runtime-gate");
const sourceDir = join(packageDir, "src");
const workflowPath = join(
  root,
  ".github",
  "workflows",
  "customer-runtime-gate-ci.yml",
);

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!entry.isFile() || !entry.name.endsWith(".ts")) return [];
    if (entry.name.endsWith(".test.ts")) return [];
    return [full];
  });
}

test("runtime gate production dependencies are customer-access only", () => {
  const packageJson = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8"),
  );

  assert.deepEqual(Object.keys(packageJson.dependencies ?? {}).sort(), [
    "@xauusd/customer-activation",
    "@xauusd/customer-grant-registry",
    "@xauusd/customer-product-access",
    "@xauusd/license-service",
  ]);
});

test("runtime gate has no trading, persistence, network or API implementation", () => {
  const all = sourceFiles(sourceDir)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  const forbidden = [
    "@xauusd/strategy-engine",
    "@xauusd/risk-engine",
    "@xauusd/execution-engine",
    "@xauusd/mt5-broker",
    "order_send",
    "position_modify",
    "position_close",
    'from "node:fs',
    'from "node:net"',
    'from "node:http"',
    'from "node:https"',
    "express",
    "axios",
    "WebSocket",
  ];

  for (const marker of forbidden) {
    assert.equal(
      all.includes(marker),
      false,
      `customer runtime gate contains forbidden marker: ${marker}`,
    );
  }

  assert.equal(/\bfetch\s*\(/.test(all), false);
});

test("runtime gate CI preserves source-only safety boundary", () => {
  assert.equal(statSync(workflowPath).isFile(), true);
  const workflow = readFileSync(workflowPath, "utf8");

  for (const expected of [
    "pnpm --filter @xauusd/customer-activation build",
    "pnpm --filter @xauusd/customer-grant-registry build",
    "pnpm --filter @xauusd/customer-runtime-gate test",
    "pnpm --filter @xauusd/customer-runtime-gate typecheck",
    "pnpm --filter @xauusd/customer-runtime-gate build",
    "node --test scripts/test-customer-runtime-gate-boundary.mjs",
    "PERSISTENCE_MUTATION=NONE",
    "NETWORK_MUTATION=NONE",
    "API_ROUTE_MUTATION=NONE",
    "ORDER_MUTATION=NONE",
    "POSITION_MUTATION=NONE",
  ]) {
    assert.equal(
      workflow.includes(expected),
      true,
      `workflow missing expected gate: ${expected}`,
    );
  }
});
