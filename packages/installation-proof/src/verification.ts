import { assertInstallationChallenge } from "./challenge.js";
import {
  parseInstallationPublicKey,
  verifyInstallationProofSignature,
  type InstallationProof,
} from "./proof.js";

export type InstallationProofFailureCode =
  | "INVALID_CHALLENGE"
  | "INVALID_PROOF"
  | "PURPOSE_MISMATCH"
  | "LICENSE_MISMATCH"
  | "INSTALLATION_MISMATCH"
  | "CHALLENGE_NOT_YET_VALID"
  | "CHALLENGE_EXPIRED"
  | "PUBLIC_KEY_MISMATCH"
  | "INVALID_EXPECTED_PUBLIC_KEY"
  | "INVALID_SIGNATURE"
  | "CHALLENGE_REPLAYED"
  | "CHALLENGE_STORE_ERROR";

export type InstallationProofFailure = {
  ok: false;
  code: InstallationProofFailureCode;
};

export type InstallationProofSuccess = {
  ok: true;
  code: "VERIFIED";
  installationPublicKey: string;
};

export type InstallationProofVerificationResult =
  | InstallationProofSuccess
  | InstallationProofFailure;

export type ConsumeInstallationChallengeOnce = (
  challengeId: string,
) => Promise<boolean>;

export type VerifyEnrollmentProofInput = {
  proof: unknown;
  expectedLicenseId: string;
  expectedInstallationId: string;
  now: number;
  consumeOnce: ConsumeInstallationChallengeOnce;
};

export type VerifyReconnectProofInput = VerifyEnrollmentProofInput & {
  expectedInstallationPublicKey: string;
};

const PROOF_KEYS = ["challenge", "installationPublicKey", "signature"] as const;

function proofRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...PROOF_KEYS].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    return null;
  }
  return record;
}

function isCanonicalSignature(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 64 && decoded.toString("base64url") === value;
}

function validateProofShape(
  value: unknown,
):
  | { ok: true; proof: InstallationProof }
  | { ok: false; code: "INVALID_CHALLENGE" | "INVALID_PROOF" } {
  const record = proofRecord(value);
  if (record === null) {
    return { ok: false, code: "INVALID_PROOF" };
  }

  try {
    assertInstallationChallenge(record.challenge);
  } catch {
    return { ok: false, code: "INVALID_CHALLENGE" };
  }

  try {
    parseInstallationPublicKey(record.installationPublicKey);
  } catch {
    return { ok: false, code: "INVALID_PROOF" };
  }

  if (!isCanonicalSignature(record.signature)) {
    return { ok: false, code: "INVALID_PROOF" };
  }

  return { ok: true, proof: record as unknown as InstallationProof };
}

function validateIdentityAndTime(
  proof: InstallationProof,
  input: VerifyEnrollmentProofInput,
  purpose: "ENROLLMENT" | "RECONNECT",
): InstallationProofFailure | null {
  if (proof.challenge.purpose !== purpose) {
    return { ok: false, code: "PURPOSE_MISMATCH" };
  }
  if (proof.challenge.licenseId !== input.expectedLicenseId) {
    return { ok: false, code: "LICENSE_MISMATCH" };
  }
  if (proof.challenge.installationId !== input.expectedInstallationId) {
    return { ok: false, code: "INSTALLATION_MISMATCH" };
  }
  if (!Number.isSafeInteger(input.now)) {
    return { ok: false, code: "INVALID_CHALLENGE" };
  }
  if (input.now < proof.challenge.issuedAt) {
    return { ok: false, code: "CHALLENGE_NOT_YET_VALID" };
  }
  if (input.now > proof.challenge.expiresAt) {
    return { ok: false, code: "CHALLENGE_EXPIRED" };
  }
  return null;
}

async function consumeVerifiedChallenge(
  proof: InstallationProof,
  consumeOnce: ConsumeInstallationChallengeOnce,
): Promise<InstallationProofVerificationResult> {
  try {
    const consumed = await consumeOnce(proof.challenge.challengeId);
    if (!consumed) {
      return { ok: false, code: "CHALLENGE_REPLAYED" };
    }
  } catch {
    return { ok: false, code: "CHALLENGE_STORE_ERROR" };
  }

  return {
    ok: true,
    code: "VERIFIED",
    installationPublicKey: proof.installationPublicKey,
  };
}

export async function verifyEnrollmentProof(
  input: VerifyEnrollmentProofInput,
): Promise<InstallationProofVerificationResult> {
  const parsed = validateProofShape(input.proof);
  if (!parsed.ok) {
    return parsed;
  }
  const { proof } = parsed;

  const identityOrTimeFailure = validateIdentityAndTime(
    proof,
    input,
    "ENROLLMENT",
  );
  if (identityOrTimeFailure !== null) {
    return identityOrTimeFailure;
  }

  if (!verifyInstallationProofSignature(proof)) {
    return { ok: false, code: "INVALID_SIGNATURE" };
  }

  return consumeVerifiedChallenge(proof, input.consumeOnce);
}

export async function verifyReconnectProof(
  input: VerifyReconnectProofInput,
): Promise<InstallationProofVerificationResult> {
  const parsed = validateProofShape(input.proof);
  if (!parsed.ok) {
    return parsed;
  }
  const { proof } = parsed;

  try {
    parseInstallationPublicKey(input.expectedInstallationPublicKey);
  } catch {
    return { ok: false, code: "INVALID_EXPECTED_PUBLIC_KEY" };
  }

  const identityOrTimeFailure = validateIdentityAndTime(
    proof,
    input,
    "RECONNECT",
  );
  if (identityOrTimeFailure !== null) {
    return identityOrTimeFailure;
  }

  if (proof.installationPublicKey !== input.expectedInstallationPublicKey) {
    return { ok: false, code: "PUBLIC_KEY_MISMATCH" };
  }

  if (!verifyInstallationProofSignature(proof)) {
    return { ok: false, code: "INVALID_SIGNATURE" };
  }

  return consumeVerifiedChallenge(proof, input.consumeOnce);
}
