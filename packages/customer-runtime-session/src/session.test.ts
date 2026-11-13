import { describe, expect, it } from "vitest";
import {
  InMemoryCustomerGrantRegistryRepository,
  registerCustomerGrant,
  revokeRegisteredCustomerGrant,
} from "@xauusd/customer-grant-registry";
import {
  createCustomerProductGrantLifecycle,
  issueCopyFollowerGrant,
  issueSelfManagedGrant,
} from "@xauusd/customer-product-access";
import type { CustomerLicenseResolver } from "@xauusd/customer-runtime-gate";
import {
  exportInstallationPublicKey,
  generateInstallationDeviceKeyPair,
  signInstallationProof,
} from "@xauusd/installation-proof";
import type { LicenseRecord } from "@xauusd/license-service";
import {
  InMemoryCustomerRuntimeChallengeStore,
  activateCopyFollowerSession,
  activateSelfManagedSession,
  issueCopyFollowerReconnectChallenge,
  issueSelfManagedReconnectChallenge,
} from "./session.js";

const NOW = 9_000_000;

class MutableClock {
  constructor(public value = NOW) {}
  now() {
    return this.value;
  }
}

function resolver(license: LicenseRecord | null): CustomerLicenseResolver {
  return {
    async get(licenseId) {
      if (!license || license.licenseId !== licenseId) return null;
      return license;
    },
  };
}

function fixture(status: LicenseRecord["status"] = "ACTIVE") {
  const keys = generateInstallationDeviceKeyPair();
  const installationPublicKey = exportInstallationPublicKey(keys.publicKey);
  const license: LicenseRecord = {
    licenseId: "license-session-001",
    status,
    customerId: "customer-session-001",
    allowedMt5Logins: [990001],
    allowedBrokerServers: ["Broker-Real"],
    installationId: "install-session-001",
    installationPublicKey,
    plan: "CUSTOMER_V1",
    maxAccounts: 1,
    issuedAt: NOW - 100_000,
    expiresAt: NOW + 100_000,
    revokedAt: status === "REVOKED" ? NOW - 1 : null,
  };
  return { license, keys };
}

async function registerSelfManaged(
  registry: InMemoryCustomerGrantRegistryRepository,
  license: LicenseRecord,
) {
  const lifecycle = createCustomerProductGrantLifecycle(
    issueSelfManagedGrant(license, {
      grantId: "grant-session-self",
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 90_000,
      allowedBotModes: ["AUTO"],
    }),
  );
  expect(await registerCustomerGrant(registry, lifecycle)).toMatchObject({
    ok: true,
    code: "REGISTERED",
  });
  return lifecycle;
}

async function registerCopyFollower(
  registry: InMemoryCustomerGrantRegistryRepository,
  license: LicenseRecord,
) {
  const lifecycle = createCustomerProductGrantLifecycle(
    issueCopyFollowerGrant(license, {
      grantId: "grant-session-copy",
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 50_000,
      allowedCopySizingModes: ["EQUITY_RATIO"],
    }),
  );
  expect(await registerCustomerGrant(registry, lifecycle)).toMatchObject({
    ok: true,
    code: "REGISTERED",
  });
  return lifecycle;
}

describe("SELF_MANAGED runtime sessions", () => {
  it("issues a server-bound reconnect challenge and activates AUTO once", async () => {
    const registry = new InMemoryCustomerGrantRegistryRepository();
    const store = new InMemoryCustomerRuntimeChallengeStore();
    const clock = new MutableClock();
    const { license, keys } = fixture();
    await registerSelfManaged(registry, license);

    const issued = await issueSelfManagedReconnectChallenge(
      registry,
      resolver(license),
      store,
      clock,
      {
        grantId: "grant-session-self",
        installationId: license.installationId,
      },
    );

    expect(issued).toMatchObject({
      ok: true,
      code: "CHALLENGE_ISSUED",
      productMode: "SELF_MANAGED",
    });
    if (!issued.ok) throw new Error("challenge must be issued");

    const proof = signInstallationProof({
      challenge: issued.challenge,
      installationPublicKey: license.installationPublicKey,
      privateKey: keys.privateKey,
    });

    const request = {
      grantId: "grant-session-self",
      installationId: license.installationId,
      mt5Login: 990001,
      brokerServer: "Broker-Real",
      requestedBotMode: "AUTO" as const,
      proof,
    };

    await expect(
      activateSelfManagedSession(
        registry,
        resolver(license),
        store,
        clock,
        request,
      ),
    ).resolves.toEqual({
      ok: true,
      code: "ACTIVATED",
      productMode: "SELF_MANAGED",
      exposureAllowed: true,
      accessCode: "AUTHORIZED",
    });

    const replay = await activateSelfManagedSession(
      registry,
      resolver(license),
      store,
      clock,
      request,
    );
    expect(replay).toMatchObject({
      ok: false,
      code: "INSTALLATION_PROOF_DENIED",
    });
  });

  it("rejects challenge requests for the wrong installation before proof exists", async () => {
    const registry = new InMemoryCustomerGrantRegistryRepository();
    const store = new InMemoryCustomerRuntimeChallengeStore();
    const clock = new MutableClock();
    const { license } = fixture();
    await registerSelfManaged(registry, license);

    await expect(
      issueSelfManagedReconnectChallenge(
        registry,
        resolver(license),
        store,
        clock,
        {
          grantId: "grant-session-self",
          installationId: "copied-installation",
        },
      ),
    ).resolves.toEqual({ ok: false, code: "INSTALLATION_MISMATCH" });
  });

  it("does not let a COPY_FOLLOWER grant mint a SELF_MANAGED challenge", async () => {
    const registry = new InMemoryCustomerGrantRegistryRepository();
    const store = new InMemoryCustomerRuntimeChallengeStore();
    const clock = new MutableClock();
    const { license } = fixture();
    await registerCopyFollower(registry, license);

    await expect(
      issueSelfManagedReconnectChallenge(
        registry,
        resolver(license),
        store,
        clock,
        {
          grantId: "grant-session-copy",
          installationId: license.installationId,
        },
      ),
    ).resolves.toEqual({ ok: false, code: "PRODUCT_MODE_MISMATCH" });
  });

  it("can issue identity proof for a suspended license but AUTO still fails closed", async () => {
    const registry = new InMemoryCustomerGrantRegistryRepository();
    const store = new InMemoryCustomerRuntimeChallengeStore();
    const clock = new MutableClock();
    const active = fixture();
    await registerSelfManaged(registry, active.license);

    const suspended: LicenseRecord = {
      ...active.license,
      status: "SUSPENDED",
      revokedAt: null,
    };

    const issued = await issueSelfManagedReconnectChallenge(
      registry,
      resolver(suspended),
      store,
      clock,
      {
        grantId: "grant-session-self",
        installationId: suspended.installationId,
      },
    );
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("challenge must be issued");

    const proof = signInstallationProof({
      challenge: issued.challenge,
      installationPublicKey: suspended.installationPublicKey,
      privateKey: active.keys.privateKey,
    });

    await expect(
      activateSelfManagedSession(
        registry,
        resolver(suspended),
        store,
        clock,
        {
          grantId: "grant-session-self",
          installationId: suspended.installationId,
          mt5Login: 990001,
          brokerServer: "Broker-Real",
          requestedBotMode: "AUTO",
          proof,
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: "ACCESS_DENIED",
      accessCode: "LICENSE_NOT_ACTIVE",
    });
  });

  it("keeps PAUSE available after grant revocation with fresh proof", async () => {
    const registry = new InMemoryCustomerGrantRegistryRepository();
    const store = new InMemoryCustomerRuntimeChallengeStore();
    const clock = new MutableClock();
    const { license, keys } = fixture();
    await registerSelfManaged(registry, license);
    await revokeRegisteredCustomerGrant(
      registry,
      "grant-session-self",
      NOW - 1,
    );

    const issued = await issueSelfManagedReconnectChallenge(
      registry,
      resolver(license),
      store,
      clock,
      {
        grantId: "grant-session-self",
        installationId: license.installationId,
      },
    );
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("challenge must be issued");

    const proof = signInstallationProof({
      challenge: issued.challenge,
      installationPublicKey: license.installationPublicKey,
      privateKey: keys.privateKey,
    });

    await expect(
      activateSelfManagedSession(
        registry,
        resolver(license),
        store,
        clock,
        {
          grantId: "grant-session-self",
          installationId: license.installationId,
          mt5Login: 990001,
          brokerServer: "Broker-Real",
          requestedBotMode: "PAUSE",
          proof,
        },
      ),
    ).resolves.toEqual({
      ok: true,
      code: "ACTIVATED",
      productMode: "SELF_MANAGED",
      exposureAllowed: false,
      accessCode: "AUTHORIZED_SAFE_PAUSE",
    });
  });

  it("rejects an expired challenge at one-time consumption", async () => {
    const registry = new InMemoryCustomerGrantRegistryRepository();
    const store = new InMemoryCustomerRuntimeChallengeStore();
    const clock = new MutableClock();
    const { license, keys } = fixture();
    await registerSelfManaged(registry, license);

    const issued = await issueSelfManagedReconnectChallenge(
      registry,
      resolver(license),
      store,
      clock,
      {
        grantId: "grant-session-self",
        installationId: license.installationId,
      },
    );
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("challenge must be issued");

    const proof = signInstallationProof({
      challenge: issued.challenge,
      installationPublicKey: license.installationPublicKey,
      privateKey: keys.privateKey,
    });

    clock.value = issued.challenge.expiresAt + 1;

    const result = await activateSelfManagedSession(
      registry,
      resolver(license),
      store,
      clock,
      {
        grantId: "grant-session-self",
        installationId: license.installationId,
        mt5Login: 990001,
        brokerServer: "Broker-Real",
        requestedBotMode: "AUTO",
        proof,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "INSTALLATION_PROOF_DENIED",
      installationProofCode: "CHALLENGE_EXPIRED",
    });
  });
});

describe("COPY_FOLLOWER runtime sessions", () => {
  it("issues a copy challenge and activates an allowlisted sizing mode", async () => {
    const registry = new InMemoryCustomerGrantRegistryRepository();
    const store = new InMemoryCustomerRuntimeChallengeStore();
    const clock = new MutableClock();
    const { license, keys } = fixture();
    await registerCopyFollower(registry, license);

    const issued = await issueCopyFollowerReconnectChallenge(
      registry,
      resolver(license),
      store,
      clock,
      {
        grantId: "grant-session-copy",
        installationId: license.installationId,
      },
    );
    expect(issued).toMatchObject({
      ok: true,
      productMode: "COPY_FOLLOWER",
    });
    if (!issued.ok) throw new Error("challenge must be issued");

    const proof = signInstallationProof({
      challenge: issued.challenge,
      installationPublicKey: license.installationPublicKey,
      privateKey: keys.privateKey,
    });

    await expect(
      activateCopyFollowerSession(
        registry,
        resolver(license),
        store,
        clock,
        {
          grantId: "grant-session-copy",
          installationId: license.installationId,
          mt5Login: 990001,
          brokerServer: "Broker-Real",
          requestedSizingMode: "EQUITY_RATIO",
          proof,
        },
      ),
    ).resolves.toEqual({
      ok: true,
      code: "ACTIVATED",
      productMode: "COPY_FOLLOWER",
      exposureAllowed: true,
      accessCode: "AUTHORIZED",
    });
  });
});
