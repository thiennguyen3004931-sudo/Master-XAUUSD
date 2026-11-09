import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourcePath = "packages/customer-follower-runtime/src/index.ts";
const packagePath = "packages/customer-follower-runtime/package.json";

test("follower runtime composition stays injection-only", async () => {
  const source = await readFile(sourcePath, "utf8");

  for (const required of [
    "createCustomerFollowerRuntime",
    "CustomerMt5BrokerPortAdapter",
    "FileCustomerFollowerPositionRegistry",
    "CustomerMt5FollowerExecutor",
  ]) {
    assert.ok(source.includes(required), "runtime missing: " + required);
  }

  for (const forbidden of [
    "HttpMt5Transport",
    "new Mt5BridgeClient",
    "node:http",
    "node:https",
    "node:net",
    "node:child_process",
    "127.0.0.1",
    "localhost",
    "order_send",
    "MetaTrader5",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      "runtime contains direct connection marker: " + forbidden,
    );
  }
});

test("follower runtime depends only on accepted customer wiring packages", async () => {
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), [
    "@xauusd/customer-agent",
    "@xauusd/customer-follower-state",
    "@xauusd/customer-mt5-broker-port-adapter",
    "@xauusd/mt5-broker",
  ]);
});
