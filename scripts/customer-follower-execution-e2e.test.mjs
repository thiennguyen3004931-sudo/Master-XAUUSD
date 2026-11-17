import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { signCopyCommand } from "../packages/copy-protocol/dist/index.js";
import {
  CustomerCopyCommandVerifier,
  CustomerFollowerExecutionAdapter,
} from "../packages/customer-agent/dist/index.js";

const NOW = 90_000_000;

test("signed COPY_FOLLOWER command reaches only the injected simulated executor", async () => {
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const publicKey = keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();

  const verifier = new CustomerCopyCommandVerifier(
    {
      licenseId: "license-follower-exec-e2e",
      installationId: "install-follower-exec-e2e",
      mt5Login: 660001,
      brokerServer: "Broker-Real",
      allowedSymbols: ["XAUUSD"],
    },
    new Map([["master-key-follower-e2e", publicKey]]),
    { now: () => NOW },
  );

  const command = signCopyCommand(
    {
      version: 1,
      commandId: "follower-exec-e2e-001",
      sequence: 1,
      licenseId: "license-follower-exec-e2e",
      installationId: "install-follower-exec-e2e",
      mt5Login: 660001,
      brokerServer: "Broker-Real",
      symbol: "XAUUSD",
      action: "POSITION_OPEN",
      payload: {
        side: "BUY",
        volume: 0.12,
        entry: 4200,
        stopLoss: 4190,
        takeProfit: 4220,
      },
      masterPositionRef: "master-position-follower-e2e-001",
      issuedAt: NOW - 100,
      expiresAt: NOW + 30_000,
      keyId: "master-key-follower-e2e",
    },
    privateKey,
  );

  const accepted = verifier.accept(command);
  assert.equal(accepted.ok, true);

  const received = [];
  const adapter = new CustomerFollowerExecutionAdapter({
    async execute(request) {
      received.push(request);
    },
  });

  const result = await adapter.dispatch(accepted);
  assert.equal(result.ok, true);
  assert.equal(result.code, "FORWARDED_TO_EXECUTOR");
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], {
    action: "POSITION_OPEN",
    commandId: "follower-exec-e2e-001",
    sequence: 1,
    symbol: "XAUUSD",
    masterPositionRef: "master-position-follower-e2e-001",
    side: "BUY",
    volume: 0.12,
    entry: 4200,
    stopLoss: 4190,
    takeProfit: 4220,
  });

  assert.deepEqual(verifier.accept(command), {
    ok: false,
    code: "REPLAYED_COMMAND",
  });
});
