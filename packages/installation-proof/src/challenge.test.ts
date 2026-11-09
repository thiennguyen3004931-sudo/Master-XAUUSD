import { describe, expect, it } from "vitest";
import {
  INSTALLATION_CHALLENGE_PURPOSES,
  MAX_INSTALLATION_CHALLENGE_TTL_MS,
  assertInstallationChallenge,
  createInstallationChallenge,
  installationChallengeCanonicalBytes
} from "./challenge.js";

const NOW = 1_789_000_000_000;

function decodeCanonicalBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  expect(decoded.toString("base64url")).toBe(value);
  return decoded;
}

describe("installation challenge contract", () => {
  it("exposes exactly ENROLLMENT and RECONNECT purposes", () => {
    expect(INSTALLATION_CHALLENGE_PURPOSES).toEqual([
      "ENROLLMENT",
      "RECONNECT"
    ]);
  });

  it.each(INSTALLATION_CHALLENGE_PURPOSES)(
    "creates a valid %s challenge with secure canonical nonce",
    (purpose) => {
      const challenge = createInstallationChallenge({
        purpose,
        licenseId: "lic-0001",
        installationId: "inst-0001",
        now: NOW,
        ttlMs: 60_000
      });

      expect(challenge).toMatchObject({
        version: 1,
        purpose,
        licenseId: "lic-0001",
        installationId: "inst-0001",
        issuedAt: NOW,
        expiresAt: NOW + 60_000
      });
      expect(challenge.challengeId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(decodeCanonicalBase64Url(challenge.nonce)).toHaveLength(32);
      expect(() => assertInstallationChallenge(challenge)).not.toThrow();
    }
  );

  it("uses fresh challenge ids and nonces", () => {
    const a = createInstallationChallenge({
      purpose: "ENROLLMENT",
      licenseId: "lic-0001",
      installationId: "inst-0001",
      now: NOW,
      ttlMs: 60_000
    });
    const b = createInstallationChallenge({
      purpose: "ENROLLMENT",
      licenseId: "lic-0001",
      installationId: "inst-0001",
      now: NOW,
      ttlMs: 60_000
    });

    expect(a.challengeId).not.toBe(b.challengeId);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it.each([0, -1, 300_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid ttlMs %s",
    (ttlMs) => {
      expect(() =>
        createInstallationChallenge({
          purpose: "ENROLLMENT",
          licenseId: "lic-0001",
          installationId: "inst-0001",
          now: NOW,
          ttlMs
        })
      ).toThrow();
    }
  );

  it("locks the maximum challenge lifetime to five minutes", () => {
    expect(MAX_INSTALLATION_CHALLENGE_TTL_MS).toBe(300_000);
  });

  it.each([
    ["blank license", { licenseId: "" }],
    ["trimmed license", { licenseId: " lic-0001 " }],
    ["blank installation", { installationId: "" }],
    ["trimmed installation", { installationId: " inst-0001 " }],
    ["unsafe now", { now: Number.MAX_SAFE_INTEGER + 1 }]
  ] as const)("fails closed when creating with %s", (_name, override) => {
    expect(() =>
      createInstallationChallenge({
        purpose: "ENROLLMENT",
        licenseId: "lic-0001",
        installationId: "inst-0001",
        now: NOW,
        ttlMs: 60_000,
        ...override
      })
    ).toThrow();
  });

  it("rejects unknown purpose at runtime", () => {
    expect(() =>
      createInstallationChallenge({
        purpose: "PAIR" as never,
        licenseId: "lic-0001",
        installationId: "inst-0001",
        now: NOW,
        ttlMs: 60_000
      })
    ).toThrow();
  });
});

describe("challenge runtime validation", () => {
  const valid = {
    version: 1,
    challengeId: "8a3e7992-2654-4ad3-9aef-16f584e87482",
    purpose: "ENROLLMENT",
    licenseId: "lic-0001",
    installationId: "inst-0001",
    nonce: Buffer.alloc(32, 7).toString("base64url"),
    issuedAt: NOW,
    expiresAt: NOW + 60_000
  } as const;

  it("accepts the exact canonical shape", () => {
    expect(() => assertInstallationChallenge(valid)).not.toThrow();
  });

  it.each([
    ["unknown field", { ...valid, extra: true }],
    ["wrong version", { ...valid, version: 2 }],
    ["wrong purpose", { ...valid, purpose: "PAIR" }],
    ["blank challengeId", { ...valid, challengeId: "" }],
    ["blank licenseId", { ...valid, licenseId: "" }],
    ["blank installationId", { ...valid, installationId: "" }],
    ["short nonce", { ...valid, nonce: Buffer.alloc(31).toString("base64url") }],
    ["noncanonical nonce", { ...valid, nonce: `${valid.nonce}=` }],
    ["expires before issued", { ...valid, expiresAt: NOW }],
    [
      "lifetime over max",
      { ...valid, expiresAt: NOW + MAX_INSTALLATION_CHALLENGE_TTL_MS + 1 }
    ],
    ["unsafe issuedAt", { ...valid, issuedAt: Number.MAX_SAFE_INTEGER + 1 }],
    ["unsafe expiresAt", { ...valid, expiresAt: Number.MAX_SAFE_INTEGER + 1 }]
  ] as const)("rejects %s", (_name, value) => {
    expect(() => assertInstallationChallenge(value)).toThrow();
  });
});

describe("challenge canonical bytes", () => {
  const challenge = {
    version: 1,
    challengeId: "8a3e7992-2654-4ad3-9aef-16f584e87482",
    purpose: "RECONNECT",
    licenseId: "lic-0001",
    installationId: "inst-0001",
    nonce: Buffer.alloc(32, 9).toString("base64url"),
    issuedAt: NOW,
    expiresAt: NOW + 60_000
  } as const;

  it("is deterministic across property insertion order", () => {
    const reordered = {
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      installationId: challenge.installationId,
      licenseId: challenge.licenseId,
      purpose: challenge.purpose,
      challengeId: challenge.challengeId,
      issuedAt: challenge.issuedAt,
      version: challenge.version
    };

    expect(
      Buffer.from(installationChallengeCanonicalBytes(challenge)).toString("hex")
    ).toBe(
      Buffer.from(installationChallengeCanonicalBytes(reordered)).toString("hex")
    );
  });

  it("changes when a security-relevant field changes", () => {
    expect(
      Buffer.from(installationChallengeCanonicalBytes(challenge)).toString("hex")
    ).not.toBe(
      Buffer.from(
        installationChallengeCanonicalBytes({
          ...challenge,
          installationId: "inst-other"
        })
      ).toString("hex")
    );
  });
});
