import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const executionPath = path.join(
  root,
  "packages",
  "customer-agent",
  "src",
  "follower-execution.ts",
);
const releaseRoot = path.join(root, "customer-release");
const packagerPath = path.join(
  root,
  "scripts",
  "package-customer-agent-release.ps1",
);

async function listFiles(dir) {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...(await listFiles(full)));
    else output.push(full);
  }
  return output;
}

test("follower execution boundary has no direct Master or MT5 dependency", async () => {
  const source = await readFile(executionPath, "utf8");
  const forbidden = [
    "@xauusd/strategy-engine",
    "@xauusd/risk-engine",
    "@xauusd/execution-engine",
    "@xauusd/mt5-broker",
    "node:http",
    "node:https",
    "node:net",
    "node:child_process",
    "order_send",
  ];

  for (const marker of forbidden) {
    assert.equal(
      source.includes(marker),
      false,
      "follower execution boundary contains forbidden marker: " + marker,
    );
  }

  for (const required of [
    "CustomerFollowerExecutor",
    "CustomerCopyCommandDecision",
    "INVALID_EXECUTION_PAYLOAD",
    "EXECUTOR_FAILED",
    "FORWARDED_TO_EXECUTOR",
  ]) {
    assert.ok(source.includes(required), "missing execution marker: " + required);
  }
});

test("customer release templates contain no embedded credential or private key", async () => {
  for (const file of await listFiles(releaseRoot)) {
    const content = await readFile(file, "utf8");
    assert.equal(
      content.includes("-----BEGIN PRIVATE KEY-----"),
      false,
      path.relative(root, file) + " embeds a private key",
    );
  }

  const config = JSON.parse(
    await readFile(
      path.join(releaseRoot, "config", "customer-agent.example.json"),
      "utf8",
    ),
  );
  assert.equal(Object.prototype.hasOwnProperty.call(config, "apiToken"), false);
});

test("release packager allowlists only customer distribution packages", async () => {
  const source = await readFile(packagerPath, "utf8");

  for (const required of [
    '"customer-agent"',
    '"copy-protocol"',
    '"installation-proof"',
    "MASTER_SOURCE_INCLUDED=NO",
    "PRIVATE_KEY_INCLUDED=NO",
    "API_TOKEN_INCLUDED=NO",
    "MT5_BRIDGE_INCLUDED=NO",
    "release-manifest.sha256",
  ]) {
    assert.ok(source.includes(required), "packager missing: " + required);
  }

  for (const forbiddenPackage of [
    '"strategy-engine"',
    '"risk-engine"',
    '"execution-engine"',
    '"mt5-broker"',
    '"customer-mt5-broker-port-adapter"',
    '"customer-follower-runtime"',
    '"customer-mt5-binding-contract"',
  ]) {
    const packageBlock = source.slice(
      source.indexOf("$packages = @("),
      source.indexOf("foreach ($package in $packages)"),
    );
    assert.equal(
      packageBlock.includes(forbiddenPackage),
      false,
      "packager includes forbidden package: " + forbiddenPackage,
    );
  }
});
