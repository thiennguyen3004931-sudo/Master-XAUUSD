import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CopyCommandBody, SignedCopyCommand } from "./command.js";
import {
  signCopyCommand,
  verifyCopyCommandSignature
} from "./ed25519.js";

const body: CopyCommandBody = {
  version: 1,
  commandId: "cmd-0001",
  sequence: 1,
  licenseId: "lic-0001",
  installationId: "inst-0001",
  mt5Login: 12345678,
  brokerServer: "Broker-Live",
  symbol: "XAUUSD",
  action: "POSITION_OPEN",
  payload: { side: "BUY", volume: 0.03 },
  masterPositionRef: "master-pos-1",
  issuedAt: 1_789_000_000_000,
  expiresAt: 1_789_000_030_000,
  keyId: "master-ed25519-2026-01"
};

function createEd25519PemPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString()
  };
}

describe("Ed25519 copy command signing", () => {
  it("verifies a valid signed command with the matching trusted key", () => {
    const { privatePem, publicPem } = createEd25519PemPair();
    const signed = signCopyCommand(body, privatePem);

    expect(signed.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(
      verifyCopyCommandSignature(
        signed,
        new Map([[body.keyId, publicPem]])
      )
    ).toEqual({ ok: true });
  });

  it("rejects payload tampering", () => {
    const { privatePem, publicPem } = createEd25519PemPair();
    const signed = signCopyCommand(body, privatePem);
    const tampered: SignedCopyCommand = {
      ...signed,
      payload: { side: "BUY", volume: 0.04 }
    };

    expect(
      verifyCopyCommandSignature(tampered, new Map([[body.keyId, publicPem]]))
    ).toEqual({ ok: false, code: "INVALID_SIGNATURE" });
  });

  it("rejects allowlisted action tampering", () => {
    const { privatePem, publicPem } = createEd25519PemPair();
    const signed = signCopyCommand(body, privatePem);
    const tampered: SignedCopyCommand = {
      ...signed,
      action: "POSITION_CLOSE"
    };

    expect(
      verifyCopyCommandSignature(tampered, new Map([[body.keyId, publicPem]]))
    ).toEqual({ ok: false, code: "INVALID_SIGNATURE" });
  });

  it("rejects an unknown keyId before crypto verification", () => {
    const { privatePem } = createEd25519PemPair();
    const signed = signCopyCommand(body, privatePem);

    expect(verifyCopyCommandSignature(signed, new Map())).toEqual({
      ok: false,
      code: "UNKNOWN_KEY_ID"
    });
  });

  it("rejects malformed base64url signatures", () => {
    const { privatePem, publicPem } = createEd25519PemPair();
    const signed = signCopyCommand(body, privatePem);
    const malformed: SignedCopyCommand = { ...signed, signature: "%%%not-base64url%%%" };

    expect(
      verifyCopyCommandSignature(malformed, new Map([[body.keyId, publicPem]]))
    ).toEqual({ ok: false, code: "MALFORMED_SIGNATURE" });
  });

  it("rejects non-Ed25519 private keys", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    expect(() => signCopyCommand(body, privatePem)).toThrow("Ed25519");
  });

  it("fails closed for non-Ed25519 trusted public keys", () => {
    const { privatePem } = createEd25519PemPair();
    const signed = signCopyCommand(body, privatePem);
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

    expect(
      verifyCopyCommandSignature(signed, new Map([[body.keyId, publicPem]]))
    ).toEqual({ ok: false, code: "INVALID_SIGNATURE" });
  });

  it("fails closed for malformed trusted public keys", () => {
    const { privatePem } = createEd25519PemPair();
    const signed = signCopyCommand(body, privatePem);

    expect(
      verifyCopyCommandSignature(
        signed,
        new Map([[body.keyId, "not-a-public-key"]])
      )
    ).toEqual({ ok: false, code: "INVALID_SIGNATURE" });
  });

  it("fails closed for malformed signed command bodies", () => {
    const { privatePem, publicPem } = createEd25519PemPair();
    const signed = signCopyCommand(body, privatePem);
    const malformedBody = {
      ...signed,
      version: 2
    } as unknown as SignedCopyCommand;

    expect(
      verifyCopyCommandSignature(
        malformedBody,
        new Map([[body.keyId, publicPem]])
      )
    ).toEqual({ ok: false, code: "INVALID_SIGNATURE" });
  });
});
