import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(root, "packages", "customer-grant-registry");
const sourceDir = join(packageDir, "src");
const workflowPath = join(
  root,
  ".github",
  "workflows",
  "customer-grant-registry-ci.yml",
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

test("customer grant registry depends only on customer product access", () => {
  const packageJson = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(packageJson.dependencies ?? {}).sort(), [
    "@xauusd/customer-product-access",
  ]);
});

test("customer grant registry contains no trading or execution dependency", () => {
  const forbidden = [
    "@xauusd/strategy-engine",
    "@xauusd/risk-engine",
    "@xauusd/execution-engine",
    "@xauusd/mt5-broker",
    "order_send",
    "position_modify",
    "position_close",
  ];

  for (const file of sourceFiles(sourceDir)) {
    const content = readFileSync(file, "utf8");
    for (const marker of forbidden) {
      assert.equal(
        content.includes(marker),
        false,
        `${relative(root, file)} contains forbidden marker ${marker}`,
      );
    }
  }
});

test("customer grant registry has no persistence or network implementation", () => {
  const forbidden = [
    /from\s+["']node:fs["']/,
    /from\s+["']node:net["']/,
    /from\s+["']node:http["']/,
    /from\s+["']node:https["']/,
    /\bexpress\b/,
    /\baxios\b/,
    /\bfetch\s*\(/,
    /\bWebSocket\b/,
    /\bsqlite\b/i,
    /better-sqlite3/,
    /writeFile/,
    /appendFile/,
  ];

  for (const file of sourceFiles(sourceDir)) {
    const content = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.equal(
        pattern.test(content),
        false,
        `${relative(root, file)} contains persistence/network marker ${pattern}`,
      );
    }
  }
});

test("customer grant registry CI keeps source-only safety gates", () => {
  assert.equal(statSync(workflowPath).isFile(), true);
  const workflow = readFileSync(workflowPath, "utf8");

  for (const expected of [
    "pnpm --filter @xauusd/customer-product-access build",
    "pnpm --filter @xauusd/customer-grant-registry test",
    "pnpm --filter @xauusd/customer-grant-registry typecheck",
    "pnpm --filter @xauusd/customer-grant-registry build",
    "node --test scripts/test-customer-grant-registry-boundary.mjs",
    "PERSISTENCE_MUTATION=NONE",
    "NETWORK_MUTATION=NONE",
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
