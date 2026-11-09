import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourcePath = "packages/customer-mt5-binding-contract/src/index.ts";
const packagePath = "packages/customer-mt5-binding-contract/package.json";

test("customer MT5 binding contract validates before client construction", async () => {
  const source = await readFile(sourcePath, "utf8");

  for (const required of [
    "bindCustomerFollowerRuntime",
    "CustomerMt5BridgeClientFactory",
    "credentialRef",
    "bridgeBaseUrl must target loopback only",
  ]) {
    assert.ok(source.includes(required), "binding contract missing: " + required);
  }

  for (const forbidden of [
    "HttpMt5Transport",
    "new Mt5BridgeClient",
    "fetch(",
    "node:http",
    "node:https",
    "node:net",
    "node:child_process",
    "order_send",
    "MetaTrader5",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      "binding contract contains direct runtime/transport marker: " + forbidden,
    );
  }
});

test("binding contract keeps raw credentials out of the package API", async () => {
  const source = await readFile(sourcePath, "utf8");
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));

  assert.equal(source.includes("apiKey:"), false);
  assert.ok(source.includes("credentialRef"));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), [
    "@xauusd/customer-follower-runtime",
    "@xauusd/mt5-broker",
  ]);
});
