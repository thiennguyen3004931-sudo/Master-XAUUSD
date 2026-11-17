import { sign as cryptoSign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createInstallationChallenge } from "./challenge.js";
import {
  exportInstallationPublicKey,
  generateInstallationDeviceKeyPair,
  installationProofBodyCanonicalBytes,
  signInstallationProof,
} from "./proof.js";
import { verifyEnrollmentProof } from "./verification.js";

const NOW = 1_789_000_000_000;

function enrollmentFixture() {
  const challenge = createInstallationChallenge({
    purpose: "ENROLLMENT",
    licenseId: "lic-0001",
    installationId: "inst-0001",
    now: NOW,
    ttlMs: 60_000,
  });
  const keyPair = generateInstallationDeviceKeyPair();
  const installationPublicKey = exportInstallationPublicKey(keyPair.publicKey);
  const proof = signInstallationProof({
    challenge,
    installationPublicKey,
    privateKey: keyPair.privateKey,
  });
  return { challenge, keyPair, installationPublicKey, proof };
}

function verifyInput(
  proof: unknown,
  consumeOnce: (challengeId: string) => Promise<boolean>,
  now = NOW + 1_000,
) {
  return {
    proof,
    expectedLicenseId: "lic-0001",
    expectedInstallationId: "inst-0001",
    now,
    consumeOnce,
  };
}

describe("enrollment proof verification", () => {
  it("verifies a valid ENROLLMENT proof and returns the canonical public key", async () => {
    const { proof, installationPublicKey, challenge } = enrollmentFixture();
    const consumeOnce = vi.fn(async () => true);

    await expect(
      verifyEnrollmentProof(verifyInput(proof, consumeOnce)),
    ).resolves.toEqual({
      ok: true,
      code: "VERIFIED",
      installationPublicKey,
    });
    expect(consumeOnce).toHaveBeenCalledTimes(1);
    expect(consumeOnce).toHaveBeenCalledWith(challenge.challengeId);
  });

  it.each([
    ["purpose", "PURPOSE_MISMATCH", { purpose: "RECONNECT" }],
    ["license", "LICENSE_MISMATCH", { licenseId: "lic-other" }],
    ["installation", "INSTALLATION_MISMATCH", { installationId: "inst-other" }],
  ] as const)("rejects %s mismatch deterministically", async (_name, code, override) => {
    const { proof } = enrollmentFixture();
    const consumeOnce = vi.fn(async () => true);
    const changedProof = {
      ...proof,
      challenge: { ...proof.challenge, ...override },
    };

    await expect(
      verifyEnrollmentProof(verifyInput(changedProof, consumeOnce)),
    ).resolves.toEqual({ ok: false, code });
    expect(consumeOnce).not.toHaveBeenCalled();
  });

  it("rejects not-yet-valid and expired challenges before consuming", async () => {
    const { proof } = enrollmentFixture();
    const consumeOnce = vi.fn(async () => true);

    await expect(
      verifyEnrollmentProof(verifyInput(proof, consumeOnce, NOW - 1)),
    ).resolves.toEqual({ ok: false, code: "CHALLENGE_NOT_YET_VALID" });
    await expect(
      verifyEnrollmentProof(
        verifyInput(proof, consumeOnce, proof.challenge.expiresAt + 1),
      ),
    ).resolves.toEqual({ ok: false, code: "CHALLENGE_EXPIRED" });
    expect(consumeOnce).not.toHaveBeenCalled();
  });

  it("rejects a copied installation that lacks the original private key", async () => {
    const { proof, installationPublicKey } = enrollmentFixture();
    const substitute = generateInstallationDeviceKeyPair();
    const forgedSignature = cryptoSign(
      null,
      installationProofBodyCanonicalBytes(
        proof.challenge,
        installationPublicKey,
      ),
      substitute.privateKey,
    ).toString("base64url");
    const consumeOnce = vi.fn(async () => true);

    await expect(
      verifyEnrollmentProof(
        verifyInput({ ...proof, signature: forgedSignature }, consumeOnce),
      ),
    ).resolves.toEqual({ ok: false, code: "INVALID_SIGNATURE" });
    expect(consumeOnce).not.toHaveBeenCalled();
  });

  it("allows exactly one atomic challenge consumption", async () => {
    const { proof } = enrollmentFixture();
    let first = true;
    const consumeOnce = vi.fn(async () => {
      if (first) {
        first = false;
        return true;
      }
      return false;
    });

    await expect(
      verifyEnrollmentProof(verifyInput(proof, consumeOnce)),
    ).resolves.toMatchObject({ ok: true, code: "VERIFIED" });
    await expect(
      verifyEnrollmentProof(verifyInput(proof, consumeOnce)),
    ).resolves.toEqual({ ok: false, code: "CHALLENGE_REPLAYED" });
    expect(consumeOnce).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the challenge store throws", async () => {
    const { proof } = enrollmentFixture();
    const consumeOnce = vi.fn(async () => {
      throw new Error("store unavailable");
    });

    await expect(
      verifyEnrollmentProof(verifyInput(proof, consumeOnce)),
    ).resolves.toEqual({ ok: false, code: "CHALLENGE_STORE_ERROR" });
  });

  it("malformed challenge and proof values never escape as exceptions", async () => {
    const { proof } = enrollmentFixture();
    const consumeOnce = vi.fn(async () => true);

    await expect(
      verifyEnrollmentProof(
        verifyInput(
          { ...proof, challenge: { ...proof.challenge, nonce: "bad" } },
          consumeOnce,
        ),
      ),
    ).resolves.toEqual({ ok: false, code: "INVALID_CHALLENGE" });

    await expect(
      verifyEnrollmentProof(
        verifyInput({ ...proof, signature: "bad=" }, consumeOnce),
      ),
    ).resolves.toEqual({ ok: false, code: "INVALID_PROOF" });

    expect(consumeOnce).not.toHaveBeenCalled();
  });
});
