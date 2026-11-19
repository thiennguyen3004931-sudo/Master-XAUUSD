import {
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { canonicalizeJson, type JsonValue } from "@xauusd/copy-protocol";
import {
  assertInstallationChallenge,
  type InstallationChallenge,
} from "./challenge.js";

export type InstallationDeviceKeyPair = {
  publicKey: KeyObject;
  privateKey: KeyObject;
};

export type InstallationProof = {
  challenge: InstallationChallenge;
  installationPublicKey: string;
  signature: string;
};

const PROOF_KEYS = [
  "challenge",
  "installationPublicKey",
  "signature",
] as const;

export function generateInstallationDeviceKeyPair(): InstallationDeviceKeyPair {
  return generateKeyPairSync("ed25519");
}

export function exportInstallationPublicKey(publicKey: KeyObject): string {
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("publicKey must be an Ed25519 public key");
  }

  const der = publicKey.export({ type: "spki", format: "der" });
  return Buffer.from(der).toString("base64url");
}

export function parseInstallationPublicKey(value: unknown): KeyObject {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new TypeError("installationPublicKey must be canonical base64url");
  }

  const der = Buffer.from(value, "base64url");
  if (der.length === 0 || der.toString("base64url") !== value) {
    throw new TypeError("installationPublicKey must be canonical base64url");
  }

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new TypeError("installationPublicKey must contain valid SPKI DER");
  }

  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("installationPublicKey must be an Ed25519 public key");
  }

  if (exportInstallationPublicKey(publicKey) !== value) {
    throw new TypeError("installationPublicKey must use canonical SPKI DER encoding");
  }

  return publicKey;
}

function decodeInstallationSignature(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new TypeError("signature must be canonical base64url");
  }

  const signature = Buffer.from(value, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== value) {
    throw new TypeError("signature must be a 64-byte canonical Ed25519 signature");
  }
  return signature;
}

export function installationProofBodyCanonicalBytes(
  challenge: unknown,
  installationPublicKey: unknown,
): Uint8Array {
  assertInstallationChallenge(challenge);
  parseInstallationPublicKey(installationPublicKey);

  const body = {
    challenge,
    installationPublicKey,
  };
  return new TextEncoder().encode(
    canonicalizeJson(body as unknown as JsonValue),
  );
}

export function signInstallationProof(input: {
  challenge: InstallationChallenge;
  installationPublicKey: string;
  privateKey: KeyObject;
}): InstallationProof {
  assertInstallationChallenge(input.challenge);
  parseInstallationPublicKey(input.installationPublicKey);

  if (
    input.privateKey.type !== "private" ||
    input.privateKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new TypeError("privateKey must be an Ed25519 private key");
  }

  const derivedPublicKey = createPublicKey(input.privateKey);
  if (exportInstallationPublicKey(derivedPublicKey) !== input.installationPublicKey) {
    throw new TypeError("privateKey does not match installationPublicKey");
  }

  const signature = cryptoSign(
    null,
    installationProofBodyCanonicalBytes(
      input.challenge,
      input.installationPublicKey,
    ),
    input.privateKey,
  ).toString("base64url");

  return {
    challenge: input.challenge,
    installationPublicKey: input.installationPublicKey,
    signature,
  };
}

function assertInstallationProof(value: unknown): asserts value is InstallationProof {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("installation proof must be an object");
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [...PROOF_KEYS].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError("installation proof must contain the exact canonical fields");
  }

  assertInstallationChallenge(record.challenge);
  parseInstallationPublicKey(record.installationPublicKey);
  decodeInstallationSignature(record.signature);
}

export function verifyInstallationProofSignature(proof: unknown): boolean {
  try {
    assertInstallationProof(proof);
    const publicKey = parseInstallationPublicKey(proof.installationPublicKey);
    const signature = decodeInstallationSignature(proof.signature);
    return cryptoVerify(
      null,
      installationProofBodyCanonicalBytes(
        proof.challenge,
        proof.installationPublicKey,
      ),
      publicKey,
      signature,
    );
  } catch {
    return false;
  }
}
