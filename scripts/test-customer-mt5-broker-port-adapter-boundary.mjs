import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourcePath =
  "packages/customer-mt5-broker-port-adapter/src/index.ts";
const packagePath =
  "packages/customer-mt5-broker-port-adapter/package.json";

test("MT5 broker port adapter remains injected and transport-agnostic", async () => {
  const source = await readFile(sourcePath, "utf8");

  for (const required of [
    "CustomerMt5BridgePort",
    "IMt5BridgeClient",
    "CustomerMt5BrokerPortAdapter",
  ]) {
    assert.ok(source.includes(required), "adapter missing: " + required);
  }

  for (const forbidden of [
    "HttpMt5Transport",
    "Mt5BridgeClient(",
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
      "adapter contains direct runtime/transport marker: " + forbidden,
    );
  }
});

test("MT5 broker port adapter has only customer-agent and mt5-broker runtime dependencies", async () => {
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), [
    "@xauusd/customer-agent",
    "@xauusd/mt5-broker",
  ]);
});
