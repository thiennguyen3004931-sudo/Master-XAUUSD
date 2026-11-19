import { describe, expect, it, vi } from "vitest";
import { createInstallationChallenge } from "./challenge.js";
import {
  exportInstallationPublicKey,
  generateInstallationDeviceKeyPair,
  signInstallationProof,
} from "./proof.js";
import { verifyReconnectProof } from "./verification.js";

const NOW = 1_789_000_000_000;

function reconnectFixture() {
  const challenge = createInstallationChallenge({
    purpose: "RECONNECT",
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
  expectedInstallationPublicKey: string,
  consumeOnce: (challengeId: string) => Promise<boolean>,
  now = NOW + 1_000,
) {
  return {
    proof,
    expectedLicenseId: "lic-0001",
    expectedInstallationId: "inst-0001",
    expectedInstallationPublicKey,
    now,
    consumeOnce,
  };
}

describe("reconnect proof verification", () => {
  it("verifies reconnect only with the enrolled canonical public key", async () => {
    const { proof, installationPublicKey, challenge } = reconnectFixture();
    const consumeOnce = vi.fn(async () => true);

    await expect(
      verifyReconnectProof(
        verifyInput(proof, installationPublicKey, consumeOnce),
      ),
    ).resolves.toEqual({
      ok: true,
      code: "VERIFIED",
      installationPublicKey,
    });
    expect(consumeOnce).toHaveBeenCalledOnce();
    expect(consumeOnce).toHaveBeenCalledWith(challenge.challengeId);
  });

  it("rejects a substitute key even when the substitute proof has a valid signature", async () => {
    const enrolled = reconnectFixture();
    const substitute = generateInstallationDeviceKeyPair();
    const substitutePublicKey = exportInstallationPublicKey(substitute.publicKey);
    const substituteProof = signInstallationProof({
      challenge: enrolled.challenge,
      installationPublicKey: substitutePublicKey,
      privateKey: substitute.privateKey,
    });
    const consumeOnce = vi.fn(async () => true);

    await expect(
      verifyReconnectProof(
        verifyInput(
          substituteProof,
          enrolled.installationPublicKey,
          consumeOnce,
        ),
      ),
    ).resolves.toEqual({ ok: false, code: "PUBLIC_KEY_MISMATCH" });
    expect(consumeOnce).not.toHaveBeenCalled();
  });

  it("rejects malformed or noncanonical expected enrolled key material fail-closed", async () => {
    const { proof, installationPublicKey } = reconnectFixture();
    const consumeOnce = vi.fn(async () => true);

    await expect(
      verifyReconnectProof(
        verifyInput(proof, `${installationPublicKey}=`, consumeOnce),
      ),
    ).resolves.toEqual({ ok: false, code: "INVALID_EXPECTED_PUBLIC_KEY" });
    await expect(
      verifyReconnectProof(verifyInput(proof, "bad=", consumeOnce)),
    ).resolves.toEqual({ ok: false, code: "INVALID_EXPECTED_PUBLIC_KEY" });
    expect(consumeOnce).not.toHaveBeenCalled();
  });

  it("binds purpose, license, installation, and time before consuming", async () => {
    const { proof, installationPublicKey } = reconnectFixture();
    const consumeOnce = vi.fn(async () => true);

    await expect(
      verifyReconnectProof(
        verifyInput(
          { ...proof, challenge: { ...proof.challenge, purpose: "ENROLLMENT" } },
          installationPublicKey,
          consumeOnce,
        ),
      ),
    ).resolves.toEqual({ ok: false, code: "PURPOSE_MISMATCH" });
    await expect(
      verifyReconnectProof({
        ...verifyInput(proof, installationPublicKey, consumeOnce),
        expectedLicenseId: "lic-other",
      }),
    ).resolves.toEqual({ ok: false, code: "LICENSE_MISMATCH" });
    await expect(
      verifyReconnectProof({
        ...verifyInput(proof, installationPublicKey, consumeOnce),
        expectedInstallationId: "inst-other",
      }),
    ).resolves.toEqual({ ok: false, code: "INSTALLATION_MISMATCH" });
    await expect(
      verifyReconnectProof(
        verifyInput(proof, installationPublicKey, consumeOnce, NOW - 1),
      ),
    ).resolves.toEqual({ ok: false, code: "CHALLENGE_NOT_YET_VALID" });
    expect(consumeOnce).not.toHaveBeenCalled();
  });

  it("rejects replay after the first successful reconnect", async () => {
    const { proof, installationPublicKey } = reconnectFixture();
    let first = true;
    const consumeOnce = vi.fn(async () => {
      if (first) {
        first = false;
        return true;
      }
      return false;
    });

    await expect(
      verifyReconnectProof(
        verifyInput(proof, installationPublicKey, consumeOnce),
      ),
    ).resolves.toMatchObject({ ok: true, code: "VERIFIED" });
    await expect(
      verifyReconnectProof(
        verifyInput(proof, installationPublicKey, consumeOnce),
      ),
    ).resolves.toEqual({ ok: false, code: "CHALLENGE_REPLAYED" });
  });

  it("malformed reconnect proof values never throw", async () => {
    const { proof, installationPublicKey } = reconnectFixture();
    const consumeOnce = vi.fn(async () => true);

    await expect(
      verifyReconnectProof(
        verifyInput(
          { ...proof, installationPublicKey: "not-a-key" },
          installationPublicKey,
          consumeOnce,
        ),
      ),
    ).resolves.toEqual({ ok: false, code: "INVALID_PROOF" });
    expect(consumeOnce).not.toHaveBeenCalled();
  });
});
