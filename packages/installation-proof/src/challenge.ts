import { randomBytes, randomUUID } from "node:crypto";
import { canonicalizeJson, type JsonValue } from "@xauusd/copy-protocol";

export const INSTALLATION_CHALLENGE_PURPOSES = [
  "ENROLLMENT",
  "RECONNECT",
] as const;

export type InstallationChallengePurpose =
  (typeof INSTALLATION_CHALLENGE_PURPOSES)[number];

export const MAX_INSTALLATION_CHALLENGE_TTL_MS = 300_000;

export type InstallationChallenge = {
  version: 1;
  challengeId: string;
  purpose: InstallationChallengePurpose;
  licenseId: string;
  installationId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
};

export type CreateInstallationChallengeInput = {
  purpose: InstallationChallengePurpose;
  licenseId: string;
  installationId: string;
  now: number;
  ttlMs: number;
};

const CHALLENGE_KEYS = [
  "version",
  "challengeId",
  "purpose",
  "licenseId",
  "installationId",
  "nonce",
  "issuedAt",
  "expiresAt",
] as const;

function assertCanonicalNonBlankString(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new TypeError(`${field} must be a canonical non-blank string`);
  }
}

function isChallengePurpose(value: unknown): value is InstallationChallengePurpose {
  return (
    typeof value === "string" &&
    (INSTALLATION_CHALLENGE_PURPOSES as readonly string[]).includes(value)
  );
}

function assertSafeTimestamp(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
}

function assertCanonicalNonce(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("nonce must be canonical base64url");
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    throw new TypeError("nonce must be canonical base64url");
  }

  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    throw new TypeError("nonce must encode exactly 32 bytes as canonical base64url");
  }
}

export function assertInstallationChallenge(
  value: unknown,
): asserts value is InstallationChallenge {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("installation challenge must be an object");
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [...CHALLENGE_KEYS].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError("installation challenge must contain the exact canonical fields");
  }

  if (record.version !== 1) {
    throw new TypeError("installation challenge version must be 1");
  }
  if (!isChallengePurpose(record.purpose)) {
    throw new TypeError("installation challenge purpose is invalid");
  }

  assertCanonicalNonBlankString(record.challengeId, "challengeId");
  assertCanonicalNonBlankString(record.licenseId, "licenseId");
  assertCanonicalNonBlankString(record.installationId, "installationId");
  assertCanonicalNonce(record.nonce);
  assertSafeTimestamp(record.issuedAt, "issuedAt");
  assertSafeTimestamp(record.expiresAt, "expiresAt");

  if (record.expiresAt <= record.issuedAt) {
    throw new TypeError("expiresAt must be greater than issuedAt");
  }

  if (record.expiresAt - record.issuedAt > MAX_INSTALLATION_CHALLENGE_TTL_MS) {
    throw new TypeError("installation challenge lifetime exceeds maximum");
  }
}

export function createInstallationChallenge(
  input: CreateInstallationChallengeInput,
): InstallationChallenge {
  if (!isChallengePurpose(input.purpose)) {
    throw new TypeError("installation challenge purpose is invalid");
  }
  assertCanonicalNonBlankString(input.licenseId, "licenseId");
  assertCanonicalNonBlankString(input.installationId, "installationId");
  assertSafeTimestamp(input.now, "now");

  if (
    !Number.isSafeInteger(input.ttlMs) ||
    input.ttlMs <= 0 ||
    input.ttlMs > MAX_INSTALLATION_CHALLENGE_TTL_MS
  ) {
    throw new TypeError("ttlMs must be a positive safe integer within the maximum lifetime");
  }

  const expiresAt = input.now + input.ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new TypeError("expiresAt must be a safe integer");
  }

  const challenge: InstallationChallenge = {
    version: 1,
    challengeId: randomUUID(),
    purpose: input.purpose,
    licenseId: input.licenseId,
    installationId: input.installationId,
    nonce: randomBytes(32).toString("base64url"),
    issuedAt: input.now,
    expiresAt,
  };

  assertInstallationChallenge(challenge);
  return challenge;
}

export function installationChallengeCanonicalBytes(
  challenge: unknown,
): Uint8Array {
  assertInstallationChallenge(challenge);
  return new TextEncoder().encode(
    canonicalizeJson(challenge as unknown as JsonValue),
  );
}
