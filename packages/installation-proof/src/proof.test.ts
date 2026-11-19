import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  exportInstallationPublicKey,
  generateInstallationDeviceKeyPair,
  installationProofBodyCanonicalBytes,
  parseInstallationPublicKey,
  signInstallationProof,
  verifyInstallationProofSignature,
} from "./proof.js";
import type { InstallationChallenge } from "./challenge.js";

const NOW = 1_789_000_000_000;
const CHALLENGE: InstallationChallenge = {
  version: 1,
  challengeId: "8a3e7992-2654-4ad3-9aef-16f584e87482",
  purpose: "ENROLLMENT",
  licenseId: "lic-0001",
  installationId: "inst-0001",
  nonce: Buffer.alloc(32, 3).toString("base64url"),
  issuedAt: NOW,
  expiresAt: NOW + 60_000,
};

describe("installation device key contract", () => {
  it("generates Ed25519 key material and canonical SPKI DER/base64url public keys", () => {
    const keyPair = generateInstallationDeviceKeyPair();
    expect(keyPair.privateKey.type).toBe("private");
    expect(keyPair.privateKey.asymmetricKeyType).toBe("ed25519");
    expect(keyPair.publicKey.type).toBe("public");
    expect(keyPair.publicKey.asymmetricKeyType).toBe("ed25519");

    const canonical = exportInstallationPublicKey(keyPair.publicKey);
    expect(canonical).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(canonical, "base64url").toString("base64url")).toBe(canonical);

    const parsed = parseInstallationPublicKey(canonical);
    expect(parsed.type).toBe("public");
    expect(parsed.asymmetricKeyType).toBe("ed25519");
    expect(exportInstallationPublicKey(parsed)).toBe(canonical);
  });

  it("rejects noncanonical and non-Ed25519 public keys", () => {
    const keyPair = generateInstallationDeviceKeyPair();
    const canonical = exportInstallationPublicKey(keyPair.publicKey);
    expect(() => parseInstallationPublicKey(`${canonical}=`)).toThrow();

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    expect(() => exportInstallationPublicKey(rsa)).toThrow();
    const rsaDer = rsa.export({ type: "spki", format: "der" }).toString("base64url");
    expect(() => parseInstallationPublicKey(rsaDer)).toThrow();
  });
});

describe("installation proof signing", () => {
  it("canonicalizes the proof body independent of property insertion order", () => {
    const { publicKey } = generateInstallationDeviceKeyPair();
    const installationPublicKey = exportInstallationPublicKey(publicKey);
    const reorderedChallenge = {
      nonce: CHALLENGE.nonce,
      expiresAt: CHALLENGE.expiresAt,
      installationId: CHALLENGE.installationId,
      licenseId: CHALLENGE.licenseId,
      purpose: CHALLENGE.purpose,
      challengeId: CHALLENGE.challengeId,
      issuedAt: CHALLENGE.issuedAt,
      version: CHALLENGE.version,
    };

    expect(
      Buffer.from(
        installationProofBodyCanonicalBytes(CHALLENGE, installationPublicKey),
      ).toString("hex"),
    ).toBe(
      Buffer.from(
        installationProofBodyCanonicalBytes(
          reorderedChallenge,
          installationPublicKey,
        ),
      ).toString("hex"),
    );
  });

  it("signs challenge plus canonical public key and verifies the round trip", () => {
    const { publicKey, privateKey } = generateInstallationDeviceKeyPair();
    const installationPublicKey = exportInstallationPublicKey(publicKey);
    const proof = signInstallationProof({
      challenge: CHALLENGE,
      installationPublicKey,
      privateKey,
    });

    expect(proof.challenge).toEqual(CHALLENGE);
    expect(proof.installationPublicKey).toBe(installationPublicKey);
    expect(Buffer.from(proof.signature, "base64url")).toHaveLength(64);
    expect(Buffer.from(proof.signature, "base64url").toString("base64url")).toBe(
      proof.signature,
    );
    expect(verifyInstallationProofSignature(proof)).toBe(true);
  });

  it("rejects challenge, public-key, and signature tampering", () => {
    const first = generateInstallationDeviceKeyPair();
    const second = generateInstallationDeviceKeyPair();
    const installationPublicKey = exportInstallationPublicKey(first.publicKey);
    const proof = signInstallationProof({
      challenge: CHALLENGE,
      installationPublicKey,
      privateKey: first.privateKey,
    });

    expect(
      verifyInstallationProofSignature({
        ...proof,
        challenge: { ...proof.challenge, licenseId: "lic-other" },
      }),
    ).toBe(false);
    expect(
      verifyInstallationProofSignature({
        ...proof,
        installationPublicKey: exportInstallationPublicKey(second.publicKey),
      }),
    ).toBe(false);
    expect(
      verifyInstallationProofSignature({ ...proof, signature: "not-base64url=" }),
    ).toBe(false);
  });

  it("rejects a non-Ed25519 private key for signing", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { publicKey } = generateInstallationDeviceKeyPair();
    const installationPublicKey = exportInstallationPublicKey(publicKey);

    expect(() =>
      signInstallationProof({
        challenge: CHALLENGE,
        installationPublicKey,
        privateKey: rsa.privateKey,
      }),
    ).toThrow();
  });
});
