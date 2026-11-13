import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const packageDir = path.join(root, "packages", "customer-agent");
const sourceDir = path.join(packageDir, "src");

async function sourceFiles() {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
    .map((entry) => path.join(sourceDir, entry.name));
}

test("customer agent depends only on installation proof", async () => {
  const pkg = JSON.parse(
    await readFile(path.join(packageDir, "package.json"), "utf8"),
  );
  assert.equal(pkg.name, "@xauusd/customer-agent");
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), [
    "@xauusd/copy-protocol",
    "@xauusd/installation-proof",
  ]);
});

test("customer agent contains no master trading, MT5, server-store, or filesystem dependency", async () => {
  const forbidden = [
    "@xauusd/strategy-engine",
    "@xauusd/risk-engine",
    "@xauusd/execution-engine",
    "@xauusd/mt5-broker",
    "@xauusd/customer-runtime-session",
    "@xauusd/customer-runtime-gate",
    "@xauusd/customer-grant-registry",
    "@xauusd/license-service",
    "node:fs",
    "node:net",
    "node:child_process",
    "order_send",
    "position_modify",
    "position_close",
    "DatabaseSync",
  ];

  for (const file of await sourceFiles()) {
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

test("network access is isolated to HTTPS transport", async () => {
  const users = [];
  for (const file of await sourceFiles()) {
    const content = await readFile(file, "utf8");
    if (content.includes("node:https") || content.includes("node:http")) {
      users.push(path.relative(root, file));
    }
  }

  assert.deepEqual(users, [
    path.join("packages", "customer-agent", "src", "https-transport.ts"),
  ]);

  const transport = await readFile(
    path.join(sourceDir, "https-transport.ts"),
    "utf8",
  );
  assert.ok(transport.includes('url.protocol !== "https:"'));
  assert.ok(transport.includes("cross-origin request is forbidden"));
  assert.ok(transport.includes("CUSTOMER_AGENT_TIMEOUT"));
});

test("agent only calls customer runtime gateway routes with bounded retry", async () => {
  const source = await readFile(path.join(sourceDir, "agent.ts"), "utf8");

  for (const required of [
    '"/v1/customer/runtime/challenge"',
    '"/v1/customer/runtime/activate"',
    "CUSTOMER_AGENT_MAX_ATTEMPTS = 3",
    "CUSTOMER_AGENT_RETRY_DELAYS_MS",
    "CHALLENGE_BINDING_MISMATCH",
    "signInstallationProof",
  ]) {
    assert.ok(source.includes(required), `customer agent missing: ${required}`);
  }

  assert.equal(source.includes("/orders"), false);
  assert.equal(source.includes("/positions"), false);
  assert.equal(source.includes("/arm"), false);
});
