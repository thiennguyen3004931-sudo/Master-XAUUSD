import { describe, expect, it } from "vitest";
import {
  createCustomerProductGrantLifecycle,
  issueCopyFollowerGrant,
  issueSelfManagedGrant,
  revokeCustomerProductGrant,
} from "@xauusd/customer-product-access";
import {
  createInstallationChallenge,
  exportInstallationPublicKey,
  generateInstallationDeviceKeyPair,
  signInstallationProof,
} from "@xauusd/installation-proof";
import type { LicenseRecord } from "@xauusd/license-service";
import {
  activateCopyFollowerCustomer,
  activateSelfManagedCustomer,
} from "./activation.js";

const NOW = 4_000_000;

function fixture() {
  const keys = generateInstallationDeviceKeyPair();
  const publicKey = exportInstallationPublicKey(keys.publicKey);
  const license: LicenseRecord = {
    licenseId: "lic-activation-001",
    status: "ACTIVE",
    customerId: "customer-activation-001",
    allowedMt5Logins: [777001],
    allowedBrokerServers: ["Broker-Real"],
    installationId: "install-activation-001",
    installationPublicKey: publicKey,
    plan: "CUSTOMER_V1",
    maxAccounts: 1,
    issuedAt: NOW - 100_000,
    expiresAt: NOW + 100_000,
    revokedAt: null,
  };

  const challenge = createInstallationChallenge({
    purpose: "RECONNECT",
    licenseId: license.licenseId,
    installationId: license.installationId,
    now: NOW - 100,
    ttlMs: 10_000,
  });

  const proof = signInstallationProof({
    challenge,
    installationPublicKey: publicKey,
    privateKey: keys.privateKey,
  });

  return { keys, publicKey, license, proof };
}

function oneTimeConsumer() {
  const seen = new Set<string>();
  return async (challengeId: string) => {
    if (seen.has(challengeId)) return false;
    seen.add(challengeId);
    return true;
  };
}

function selfLifecycle(
  license: LicenseRecord,
  allowedBotModes: readonly ("AUTO" | "SEMI")[] = ["AUTO"],
) {
  return createCustomerProductGrantLifecycle(
    issueSelfManagedGrant(license, {
      grantId: "grant-self-activation",
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 10_000,
      allowedBotModes,
    }),
  );
}

function copyLifecycle(
  license: LicenseRecord,
  allowedCopySizingModes: readonly ("EQUITY_RATIO" | "FIXED_LOT")[] = [
    "EQUITY_RATIO",
  ],
) {
  return createCustomerProductGrantLifecycle(
    issueCopyFollowerGrant(license, {
      grantId: "grant-copy-activation",
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 10_000,
      allowedCopySizingModes,
    }),
  );
}

describe("SELF_MANAGED activation", () => {
  it("activates only after lifecycle access and bound installation proof both pass", async () => {
    const { license, proof } = fixture();
    const lifecycle = selfLifecycle(license);

    await expect(
      activateSelfManagedCustomer(license, lifecycle, {
        installationId: license.installationId,
        mt5Login: 777001,
        brokerServer: "Broker-Real",
        now: NOW,
        requestedBotMode: "AUTO",
        proof,
        consumeOnce: oneTimeConsumer(),
      }),
    ).resolves.toEqual({
      ok: true,
      code: "ACTIVATED",
      productMode: "SELF_MANAGED",
      exposureAllowed: true,
      accessCode: "AUTHORIZED",
    });
  });

  it("fails access before consuming an installation challenge", async () => {
    const { license, proof } = fixture();
    const lifecycle = selfLifecycle(license, ["SEMI"]);

    let consumeCalls = 0;
    const decision = await activateSelfManagedCustomer(license, lifecycle, {
      installationId: license.installationId,
      mt5Login: 777001,
      brokerServer: "Broker-Real",
      now: NOW,
      requestedBotMode: "AUTO",
      proof,
      consumeOnce: async () => {
        consumeCalls += 1;
        return true;
      },
    });

    expect(decision).toMatchObject({
      ok: false,
      code: "ACCESS_DENIED",
      accessCode: "BOT_MODE_NOT_ALLOWED",
    });
    expect(consumeCalls).toBe(0);
  });

  it("blocks revoked AUTO activation before proof consumption", async () => {
    const { license, proof } = fixture();
    const lifecycle = revokeCustomerProductGrant(
      selfLifecycle(license),
      NOW - 1,
    );

    let consumeCalls = 0;
    const decision = await activateSelfManagedCustomer(license, lifecycle, {
      installationId: license.installationId,
      mt5Login: 777001,
      brokerServer: "Broker-Real",
      now: NOW,
      requestedBotMode: "AUTO",
      proof,
      consumeOnce: async () => {
        consumeCalls += 1;
        return true;
      },
    });

    expect(decision).toMatchObject({
      ok: false,
      code: "ACCESS_DENIED",
      accessCode: "GRANT_REVOKED",
    });
    expect(consumeCalls).toBe(0);
  });

  it("keeps safety PAUSE activatable after grant revocation", async () => {
    const { license, proof } = fixture();
    const lifecycle = revokeCustomerProductGrant(
      selfLifecycle(license),
      NOW - 1,
    );

    await expect(
      activateSelfManagedCustomer(license, lifecycle, {
        installationId: license.installationId,
        mt5Login: 777001,
        brokerServer: "Broker-Real",
        now: NOW,
        requestedBotMode: "PAUSE",
        proof,
        consumeOnce: oneTimeConsumer(),
      }),
    ).resolves.toEqual({
      ok: true,
      code: "ACTIVATED",
      productMode: "SELF_MANAGED",
      exposureAllowed: false,
      accessCode: "AUTHORIZED_SAFE_PAUSE",
    });
  });

  it("rejects a proof from another device key", async () => {
    const { license } = fixture();
    const otherKeys = generateInstallationDeviceKeyPair();
    const otherPublicKey = exportInstallationPublicKey(otherKeys.publicKey);
    const challenge = createInstallationChallenge({
      purpose: "RECONNECT",
      licenseId: license.licenseId,
      installationId: license.installationId,
      now: NOW - 100,
      ttlMs: 10_000,
    });
    const wrongProof = signInstallationProof({
      challenge,
      installationPublicKey: otherPublicKey,
      privateKey: otherKeys.privateKey,
    });

    const lifecycle = selfLifecycle(license);

    await expect(
      activateSelfManagedCustomer(license, lifecycle, {
        installationId: license.installationId,
        mt5Login: 777001,
        brokerServer: "Broker-Real",
        now: NOW,
        requestedBotMode: "AUTO",
        proof: wrongProof,
        consumeOnce: oneTimeConsumer(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "INSTALLATION_PROOF_DENIED",
      installationProofCode: "PUBLIC_KEY_MISMATCH",
    });
  });

  it("rejects replay of an already consumed challenge", async () => {
    const { license, proof } = fixture();
    const lifecycle = selfLifecycle(license);
    const consumeOnce = oneTimeConsumer();

    const request = {
      installationId: license.installationId,
      mt5Login: 777001,
      brokerServer: "Broker-Real",
      now: NOW,
      requestedBotMode: "AUTO" as const,
      proof,
      consumeOnce,
    };

    await expect(
      activateSelfManagedCustomer(license, lifecycle, request),
    ).resolves.toMatchObject({ ok: true, code: "ACTIVATED" });

    await expect(
      activateSelfManagedCustomer(license, lifecycle, request),
    ).resolves.toMatchObject({
      ok: false,
      code: "INSTALLATION_PROOF_DENIED",
      installationProofCode: "CHALLENGE_REPLAYED",
    });
  });
});

describe("COPY_FOLLOWER activation", () => {
  it("activates a follower only for an allowlisted sizing mode and bound device", async () => {
    const { license, proof } = fixture();
    const lifecycle = copyLifecycle(license);

    await expect(
      activateCopyFollowerCustomer(license, lifecycle, {
        installationId: license.installationId,
        mt5Login: 777001,
        brokerServer: "Broker-Real",
        now: NOW,
        requestedSizingMode: "EQUITY_RATIO",
        proof,
        consumeOnce: oneTimeConsumer(),
      }),
    ).resolves.toEqual({
      ok: true,
      code: "ACTIVATED",
      productMode: "COPY_FOLLOWER",
      exposureAllowed: true,
      accessCode: "AUTHORIZED",
    });
  });

  it("blocks revoked follower activation before proof consumption", async () => {
    const { license, proof } = fixture();
    const lifecycle = revokeCustomerProductGrant(
      copyLifecycle(license),
      NOW - 1,
    );

    let consumeCalls = 0;
    const decision = await activateCopyFollowerCustomer(license, lifecycle, {
      installationId: license.installationId,
      mt5Login: 777001,
      brokerServer: "Broker-Real",
      now: NOW,
      requestedSizingMode: "EQUITY_RATIO",
      proof,
      consumeOnce: async () => {
        consumeCalls += 1;
        return true;
      },
    });

    expect(decision).toMatchObject({
      ok: false,
      code: "ACCESS_DENIED",
      accessCode: "GRANT_REVOKED",
    });
    expect(consumeCalls).toBe(0);
  });

  it("blocks a wrong broker before proof consumption", async () => {
    const { license, proof } = fixture();
    const lifecycle = copyLifecycle(license, ["FIXED_LOT"]);

    let consumeCalls = 0;
    const decision = await activateCopyFollowerCustomer(license, lifecycle, {
      installationId: license.installationId,
      mt5Login: 777001,
      brokerServer: "Other-Broker",
      now: NOW,
      requestedSizingMode: "FIXED_LOT",
      proof,
      consumeOnce: async () => {
        consumeCalls += 1;
        return true;
      },
    });

    expect(decision).toMatchObject({
      ok: false,
      code: "ACCESS_DENIED",
      accessCode: "BROKER_SERVER_NOT_ALLOWED",
    });
    expect(consumeCalls).toBe(0);
  });
});
