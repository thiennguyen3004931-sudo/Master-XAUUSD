import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signCopyCommand } from "@xauusd/copy-protocol";
import { CustomerCopyCommandVerifier } from "./copy-follower.js";

const NOW = 40_000_000;

function masterKeys() {
  const keys = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: keys.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    publicKeyPem: keys.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
  };
}

function body(sequence = 1, commandId = "cmd-001") {
  return {
    version: 1 as const,
    commandId,
    sequence,
    licenseId: "license-copy-001",
    installationId: "install-copy-001",
    mt5Login: 330001,
    brokerServer: "Broker-Real",
    symbol: "XAUUSD",
    action: "POSITION_OPEN" as const,
    payload: {
      side: "BUY",
      volume: 0.1,
      entry: 4200,
    },
    masterPositionRef: "master-pos-001",
    issuedAt: NOW - 100,
    expiresAt: NOW + 10_000,
    keyId: "master-key-001",
  };
}

function verifier(publicKeyPem: string) {
  return new CustomerCopyCommandVerifier(
    {
      licenseId: "license-copy-001",
      installationId: "install-copy-001",
      mt5Login: 330001,
      brokerServer: "Broker-Real",
      allowedSymbols: ["XAUUSD"],
    },
    new Map([["master-key-001", publicKeyPem]]),
    { now: () => NOW },
  );
}

describe("CustomerCopyCommandVerifier", () => {
  it("accepts a correctly signed and bound copy command exactly once", () => {
    const keys = masterKeys();
    const command = signCopyCommand(body(), keys.privateKeyPem);
    const subject = verifier(keys.publicKeyPem);

    expect(subject.accept(command)).toMatchObject({
      ok: true,
      code: "ACCEPTED",
    });
    expect(subject.accept(command)).toEqual({
      ok: false,
      code: "REPLAYED_COMMAND",
    });
  });

  it("rejects non-monotonic sequence even with a valid new signature", () => {
    const keys = masterKeys();
    const subject = verifier(keys.publicKeyPem);

    expect(
      subject.accept(signCopyCommand(body(2, "cmd-002"), keys.privateKeyPem)),
    ).toMatchObject({ ok: true });

    expect(
      subject.accept(signCopyCommand(body(1, "cmd-003"), keys.privateKeyPem)),
    ).toEqual({
      ok: false,
      code: "SEQUENCE_NOT_MONOTONIC",
    });
  });

  it("rejects a command bound to another installation", () => {
    const keys = masterKeys();
    const subject = verifier(keys.publicKeyPem);
    const wrong = signCopyCommand(
      { ...body(), installationId: "install-other" },
      keys.privateKeyPem,
    );

    expect(subject.accept(wrong)).toEqual({
      ok: false,
      code: "BINDING_MISMATCH",
    });
  });

  it("rejects a tampered signed command", () => {
    const keys = masterKeys();
    const subject = verifier(keys.publicKeyPem);
    const signed = signCopyCommand(body(), keys.privateKeyPem);
    const tampered = {
      ...signed,
      payload: {
        ...signed.payload,
        volume: 9.9,
      },
    };

    expect(subject.accept(tampered)).toEqual({
      ok: false,
      code: "SIGNATURE_DENIED",
    });
  });
});
