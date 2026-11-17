import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signCopyCommand, type JsonObject } from "@xauusd/copy-protocol";
import { CustomerCopyCommandVerifier } from "./copy-follower.js";
import {
  CustomerFollowerExecutionAdapter,
  type CustomerFollowerExecutionRequest,
} from "./follower-execution.js";

const NOW = 80_000_000;

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    publicKey: pair.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
  };
}

function verifier(publicKey: string) {
  return new CustomerCopyCommandVerifier(
    {
      licenseId: "license-exec-001",
      installationId: "install-exec-001",
      mt5Login: 550001,
      brokerServer: "Broker-Real",
      allowedSymbols: ["XAUUSD"],
    },
    new Map([["master-key-001", publicKey]]),
    { now: () => NOW },
  );
}

function body(payload: JsonObject) {
  return {
    version: 1 as const,
    commandId: "exec-command-001",
    sequence: 1,
    licenseId: "license-exec-001",
    installationId: "install-exec-001",
    mt5Login: 550001,
    brokerServer: "Broker-Real",
    symbol: "XAUUSD",
    action: "POSITION_OPEN" as const,
    payload,
    masterPositionRef: "master-pos-exec-001",
    issuedAt: NOW - 100,
    expiresAt: NOW + 10_000,
    keyId: "master-key-001",
  };
}

describe("CustomerFollowerExecutionAdapter", () => {
  it("forwards a verified strict POSITION_OPEN request to an injected executor", async () => {
    const key = keys();
    const accepted = verifier(key.publicKey).accept(
      signCopyCommand(
        body({
          side: "BUY",
          volume: 0.1,
          entry: 4200,
          stopLoss: 4190,
          takeProfit: 4220,
        }),
        key.privateKey,
      ),
    );

    const received: CustomerFollowerExecutionRequest[] = [];
    const adapter = new CustomerFollowerExecutionAdapter({
      async execute(request) {
        received.push(request);
      },
    });

    const result = await adapter.dispatch(accepted);
    expect(result).toMatchObject({
      ok: true,
      code: "FORWARDED_TO_EXECUTOR",
      request: {
        action: "POSITION_OPEN",
        side: "BUY",
        volume: 0.1,
        stopLoss: 4190,
      },
    });
    expect(received).toHaveLength(1);
  });

  it("fails closed when a verified command has an unsafe execution payload", async () => {
    const key = keys();
    const accepted = verifier(key.publicKey).accept(
      signCopyCommand(
        body({
          side: "BUY",
          volume: 0,
        }),
        key.privateKey,
      ),
    );

    let calls = 0;
    const adapter = new CustomerFollowerExecutionAdapter({
      async execute() {
        calls += 1;
      },
    });

    await expect(adapter.dispatch(accepted)).resolves.toEqual({
      ok: false,
      code: "INVALID_EXECUTION_PAYLOAD",
    });
    expect(calls).toBe(0);
  });

  it("does not invoke the executor for a rejected copy command", async () => {
    let calls = 0;
    const adapter = new CustomerFollowerExecutionAdapter({
      async execute() {
        calls += 1;
      },
    });

    await expect(
      adapter.dispatch({ ok: false, code: "BINDING_MISMATCH" }),
    ).resolves.toEqual({
      ok: false,
      code: "COMMAND_NOT_ACCEPTED",
    });
    expect(calls).toBe(0);
  });

  it("fails closed when the injected executor throws", async () => {
    const key = keys();
    const accepted = verifier(key.publicKey).accept(
      signCopyCommand(
        body({
          side: "SELL",
          volume: 0.2,
        }),
        key.privateKey,
      ),
    );

    const adapter = new CustomerFollowerExecutionAdapter({
      async execute() {
        throw new Error("simulated downstream failure");
      },
    });

    await expect(adapter.dispatch(accepted)).resolves.toEqual({
      ok: false,
      code: "EXECUTOR_FAILED",
    });
  });
});
