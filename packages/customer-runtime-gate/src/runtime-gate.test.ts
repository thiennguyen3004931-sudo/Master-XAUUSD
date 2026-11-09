import { describe, expect, it } from "vitest";
import {
  InMemoryCustomerGrantRegistryRepository,
  registerCustomerGrant,
  revokeRegisteredCustomerGrant,
  type CustomerGrantRegistryRepository,
} from "@xauusd/customer-grant-registry";
import {
  createCustomerProductGrantLifecycle,
  issueCopyFollowerGrant,
  issueSelfManagedGrant,
} from "@xauusd/customer-product-access";
import {
  createInstallationChallenge,
  exportInstallationPublicKey,
  generateInstallationDeviceKeyPair,
  signInstallationProof,
} from "@xauusd/installation-proof";
import type { LicenseRecord } from "@xauusd/license-service";
import {
  activateCopyFollowerRuntime,
  activateSelfManagedRuntime,
  type CustomerLicenseResolver,
  type CustomerRuntimeSecurityServices,
} from "./runtime-gate.js";

const NOW = 7_000_000;

function oneTimeConsumer() {
  const seen = new Set<string>();
  return async (challengeId: string) => {
    if (seen.has(challengeId)) return false;
    seen.add(challengeId);
    return true;
  };
}

function security(
  consumeOnce = oneTimeConsumer(),
  times: readonly number[] = [NOW, NOW],
): CustomerRuntimeSecurityServices {
  let index = 0;
  return {
    now() {
      const value = times[Math.min(index, times.length - 1)];
      index += 1;
      return value;
    },
    consumeOnce,
  };
}

function fixture(status: LicenseRecord["status"] = "ACTIVE") {
  const keys = generateInstallationDeviceKeyPair();
  const installationPublicKey = exportInstallationPublicKey(keys.publicKey);
  const license: LicenseRecord = {
    licenseId: "license-runtime-001",
    status,
    customerId: "customer-runtime-001",
    allowedMt5Logins: [880001],
    allowedBrokerServers: ["Broker-Real"],
    installationId: "install-runtime-001",
    installationPublicKey,
    plan: "CUSTOMER_V1",
    maxAccounts: 1,
    issuedAt: NOW - 100_000,
    expiresAt: NOW + 100_000,
    revokedAt: status === "REVOKED" ? NOW - 1_000 : null,
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
    installationPublicKey,
    privateKey: keys.privateKey,
  });

  return { license, proof };
}

function resolver(
  license: unknown | null,
  seen: string[] = [],
): CustomerLicenseResolver {
  return {
    async get(licenseId) {
      seen.push(licenseId);
      return license;
    },
  };
}

async function registerSelfManaged(
  repository: InMemoryCustomerGrantRegistryRepository,
  license: LicenseRecord,
) {
  const lifecycle = createCustomerProductGrantLifecycle(
    issueSelfManagedGrant(license, {
      grantId: "grant-runtime-self",
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 10_000,
      allowedBotModes: ["AUTO"],
    }),
  );
  const registered = await registerCustomerGrant(repository, lifecycle);
  expect(registered).toMatchObject({ ok: true, code: "REGISTERED" });
  return lifecycle;
}

async function registerCopyFollower(
  repository: InMemoryCustomerGrantRegistryRepository,
  license: LicenseRecord,
) {
  const lifecycle = createCustomerProductGrantLifecycle(
    issueCopyFollowerGrant(license, {
      grantId: "grant-runtime-copy",
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 10_000,
      allowedCopySizingModes: ["EQUITY_RATIO"],
    }),
  );
  const registered = await registerCustomerGrant(repository, lifecycle);
  expect(registered).toMatchObject({ ok: true, code: "REGISTERED" });
  return lifecycle;
}

describe("SELF_MANAGED runtime gate", () => {
  it("resolves lifecycle, license, time and replay consumer server-side", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();
    const { license, proof } = fixture();
    await registerSelfManaged(repository, license);
    const licenseLookups: string[] = [];

    await expect(
      activateSelfManagedRuntime(
        repository,
        resolver(license, licenseLookups),
        security(),
        {
          grantId: "grant-runtime-self",
          installationId: license.installationId,
          mt5Login: 880001,
          brokerServer: "Broker-Real",
          requestedBotMode: "AUTO",
          proof,
        },
      ),
    ).resolves.toEqual({
      ok: true,
      code: "ACTIVATED",
      productMode: "SELF_MANAGED",
      exposureAllowed: true,
      accessCode: "AUTHORIZED",
    });

    expect(licenseLookups).toEqual([license.licenseId, license.licenseId]);
  });

  it("rejects caller-supplied trusted fields before repository access", async () => {
    let repositoryCalls = 0;
    const repository: CustomerGrantRegistryRepository = {
      async get() {
        repositoryCalls += 1;
        throw new Error("must not read");
      },
      async compareAndSet() {
        repositoryCalls += 1;
        throw new Error("must not write");
      },
      async list() {
        repositoryCalls += 1;
        throw new Error("must not list");
      },
    };
    let licenseCalls = 0;

    const result = await activateSelfManagedRuntime(
      repository,
      {
        async get() {
          licenseCalls += 1;
          return null;
        },
      },
      security(),
      {
        grantId: "grant-runtime-self",
        installationId: "install-runtime-001",
        mt5Login: 880001,
        brokerServer: "Broker-Real",
        requestedBotMode: "AUTO",
        proof: {},
        now: NOW,
        consumeOnce: async () => true,
        lifecycle: { stale: true },
        license: { stale: true },
      },
    );

    expect(result).toEqual({ ok: false, code: "INVALID_RUNTIME_REQUEST" });
    expect(repositoryCalls).toBe(0);
    expect(licenseCalls).toBe(0);
  });

  it("rejects an invalid server security context before source access", async () => {
    let repositoryCalls = 0;
    const repository: CustomerGrantRegistryRepository = {
      async get() {
        repositoryCalls += 1;
        return null;
      },
      async compareAndSet() {
        throw new Error("must not write");
      },
      async list() {
        throw new Error("must not list");
      },
    };

    const { license, proof } = fixture();
    const result = await activateSelfManagedRuntime(
      repository,
      resolver(license),
      { now: () => Number.NaN, consumeOnce: oneTimeConsumer() },
      {
        grantId: "grant-runtime-self",
        installationId: license.installationId,
        mt5Login: 880001,
        brokerServer: "Broker-Real",
        requestedBotMode: "AUTO",
        proof,
      },
    );

    expect(result).toEqual({
      ok: false,
      code: "INVALID_RUNTIME_SECURITY_CONTEXT",
    });
    expect(repositoryCalls).toBe(0);
  });

  it("blocks revoked AUTO before proof consumption", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();
    const { license, proof } = fixture();
    await registerSelfManaged(repository, license);
    await revokeRegisteredCustomerGrant(
      repository,
      "grant-runtime-self",
      NOW - 1,
    );

    let consumeCalls = 0;
    const decision = await activateSelfManagedRuntime(
      repository,
      resolver(license),
      security(async () => {
        consumeCalls += 1;
        return true;
      }),
      {
        grantId: "grant-runtime-self",
        installationId: license.installationId,
        mt5Login: 880001,
        brokerServer: "Broker-Real",
        requestedBotMode: "AUTO",
        proof,
      },
    );

    expect(decision).toMatchObject({
      ok: false,
      code: "ACCESS_DENIED",
      accessCode: "GRANT_REVOKED",
    });
    expect(consumeCalls).toBe(0);
  });

  it("keeps safety PAUSE available after current grant revocation", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();
    const { license, proof } = fixture();
    await registerSelfManaged(repository, license);
    await revokeRegisteredCustomerGrant(
      repository,
      "grant-runtime-self",
      NOW - 1,
    );

    await expect(
      activateSelfManagedRuntime(
        repository,
        resolver(license),
        security(),
        {
          grantId: "grant-runtime-self",
          installationId: license.installationId,
          mt5Login: 880001,
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

  it("uses current license status from the resolver", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();
    const activeFixture = fixture("ACTIVE");
    await registerSelfManaged(repository, activeFixture.license);

    const suspended: LicenseRecord = {
      ...activeFixture.license,
      status: "SUSPENDED",
      revokedAt: null,
    };

    let consumeCalls = 0;
    const decision = await activateSelfManagedRuntime(
      repository,
      resolver(suspended),
      security(async () => {
        consumeCalls += 1;
        return true;
      }),
      {
        grantId: "grant-runtime-self",
        installationId: suspended.installationId,
        mt5Login: 880001,
        brokerServer: "Broker-Real",
        requestedBotMode: "AUTO",
        proof: activeFixture.proof,
      },
    );

    expect(decision).toMatchObject({
      ok: false,
      code: "ACCESS_DENIED",
      accessCode: "LICENSE_NOT_ACTIVE",
    });
    expect(consumeCalls).toBe(0);
  });

  it("fails closed if the grant changes after proof verification", async () => {
    const { license, proof } = fixture();
    const active = createCustomerProductGrantLifecycle(
      issueSelfManagedGrant(license, {
        grantId: "grant-runtime-self",
        issuedAt: NOW - 1_000,
        expiresAt: NOW + 10_000,
        allowedBotModes: ["AUTO"],
      }),
    );
    const revoked = {
      ...active,
      status: "REVOKED" as const,
      revokedAt: NOW,
      revision: 2,
    };

    let reads = 0;
    const repository: CustomerGrantRegistryRepository = {
      async get() {
        reads += 1;
        return reads === 1 ? active : revoked;
      },
      async compareAndSet() {
        throw new Error("must not write");
      },
      async list() {
        throw new Error("must not list");
      },
    };

    let consumeCalls = 0;
    const decision = await activateSelfManagedRuntime(
      repository,
      resolver(license),
      security(async () => {
        consumeCalls += 1;
        return true;
      }),
      {
        grantId: "grant-runtime-self",
        installationId: license.installationId,
        mt5Login: 880001,
        brokerServer: "Broker-Real",
        requestedBotMode: "AUTO",
        proof,
      },
    );

    expect(decision).toEqual({ ok: false, code: "RUNTIME_STATE_CHANGED" });
    expect(consumeCalls).toBe(1);
    expect(reads).toBe(2);
  });

  it("fails closed if the current license changes after proof verification", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();
    const { license, proof } = fixture();
    await registerSelfManaged(repository, license);

    const suspended: LicenseRecord = {
      ...license,
      status: "SUSPENDED",
      revokedAt: null,
    };
    let lookups = 0;
    const licenses: CustomerLicenseResolver = {
      async get() {
        lookups += 1;
        return lookups === 1 ? license : suspended;
      },
    };

    let consumeCalls = 0;
    const decision = await activateSelfManagedRuntime(
      repository,
      licenses,
      security(async () => {
        consumeCalls += 1;
        return true;
      }),
      {
        grantId: "grant-runtime-self",
        installationId: license.installationId,
        mt5Login: 880001,
        brokerServer: "Broker-Real",
        requestedBotMode: "AUTO",
        proof,
      },
    );

    expect(decision).toEqual({ ok: false, code: "RUNTIME_STATE_CHANGED" });
    expect(consumeCalls).toBe(1);
    expect(lookups).toBe(2);
  });

  it("fails closed if server time crosses grant expiry during proof verification", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();
    const { license, proof } = fixture();
    await registerSelfManaged(repository, license);

    const decision = await activateSelfManagedRuntime(
      repository,
      resolver(license),
      security(oneTimeConsumer(), [NOW, NOW + 20_000]),
      {
        grantId: "grant-runtime-self",
        installationId: license.installationId,
        mt5Login: 880001,
        brokerServer: "Broker-Real",
        requestedBotMode: "AUTO",
        proof,
      },
    );

    expect(decision).toEqual({ ok: false, code: "RUNTIME_STATE_CHANGED" });
  });

  it("fails closed for missing grants or licenses", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();
    const { license, proof } = fixture();
    const request = {
      grantId: "grant-runtime-self",
      installationId: license.installationId,
      mt5Login: 880001,
      brokerServer: "Broker-Real",
      requestedBotMode: "AUTO" as const,
      proof,
    };

    await expect(
      activateSelfManagedRuntime(
        repository,
        resolver(license),
        security(),
        request,
      ),
    ).resolves.toEqual({ ok: false, code: "GRANT_NOT_FOUND" });

    await registerSelfManaged(repository, license);

    await expect(
      activateSelfManagedRuntime(
        repository,
        resolver(null),
        security(),
        request,
      ),
    ).resolves.toEqual({ ok: false, code: "LICENSE_NOT_FOUND" });
  });
});

describe("COPY_FOLLOWER runtime gate", () => {
  it("resolves the current copy grant and activates an allowed follower", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();
    const { license, proof } = fixture();
    await registerCopyFollower(repository, license);

    await expect(
      activateCopyFollowerRuntime(
        repository,
        resolver(license),
        security(),
        {
          grantId: "grant-runtime-copy",
          installationId: license.installationId,
          mt5Login: 880001,
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

  it("rejects using a COPY_FOLLOWER grant through SELF_MANAGED activation", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();
    const { license, proof } = fixture();
    await registerCopyFollower(repository, license);

    let consumeCalls = 0;
    const decision = await activateSelfManagedRuntime(
      repository,
      resolver(license),
      security(async () => {
        consumeCalls += 1;
        return true;
      }),
      {
        grantId: "grant-runtime-copy",
        installationId: license.installationId,
        mt5Login: 880001,
        brokerServer: "Broker-Real",
        requestedBotMode: "AUTO",
        proof,
      },
    );

    expect(decision).toEqual({ ok: false, code: "PRODUCT_MODE_MISMATCH" });
    expect(consumeCalls).toBe(0);
  });
});
