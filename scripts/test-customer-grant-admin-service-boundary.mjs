import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(root, "packages", "customer-grant-admin-service");
const sourceDir = join(packageDir, "src");
const workflowPath = join(
  root,
  ".github",
  "workflows",
  "customer-grant-admin-service-ci.yml",
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

test("admin service depends only on approved customer access packages", () => {
  const packageJson = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8"),
  );

  assert.deepEqual(Object.keys(packageJson.dependencies ?? {}).sort(), [
    "@xauusd/customer-grant-registry",
    "@xauusd/customer-product-access",
  ]);
});

test("admin service contains persistence but no network or trading dependency", () => {
  const all = sourceFiles(sourceDir)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  assert.equal(all.includes('from "node:fs/promises"'), true);
  assert.equal(all.includes('from "node:crypto"'), true);

  const forbidden = [
    "@xauusd/strategy-engine",
    "@xauusd/risk-engine",
    "@xauusd/execution-engine",
    "@xauusd/mt5-broker",
    "order_send",
    "position_modify",
    "position_close",
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
      `customer grant admin service contains forbidden marker: ${marker}`,
    );
  }

  assert.equal(/\bfetch\s*\(/.test(all), false);
});

test("admin service has no direct production API integration", () => {
  const packageJson = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8"),
  );
  assert.equal("@xauusd/api" in (packageJson.dependencies ?? {}), false);
  assert.equal("express" in (packageJson.dependencies ?? {}), false);
});

test("dedicated CI proves persistence and source-only safety boundary", () => {
  assert.equal(statSync(workflowPath).isFile(), true);
  const workflow = readFileSync(workflowPath, "utf8");

  for (const expected of [
    "pnpm --filter @xauusd/customer-grant-registry build",
    "pnpm --filter @xauusd/customer-grant-admin-service test",
    "pnpm --filter @xauusd/customer-grant-admin-service typecheck",
    "pnpm --filter @xauusd/customer-grant-admin-service build",
    "node --test scripts/test-customer-grant-admin-service-boundary.mjs",
    "PERSISTENCE_IMPLEMENTATION=PRIVATE_SOURCE_ONLY",
    "PRODUCTION_PERSISTENCE_MUTATION=NONE",
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
