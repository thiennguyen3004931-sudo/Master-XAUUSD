import { describe, expect, it } from "vitest";
import {
  createCustomerProductGrantLifecycle,
  revokeCustomerProductGrant,
  type CustomerProductGrant,
  type CustomerProductGrantLifecycleRecord,
} from "@xauusd/customer-product-access";
import {
  InMemoryCustomerGrantRegistryRepository,
  getCustomerGrantAdminView,
  listCustomerGrantAdminViews,
  registerCustomerGrant,
  revokeRegisteredCustomerGrant,
  type CustomerGrantRegistryRepository,
} from "./registry.js";

const NOW = 5_000_000;

function selfGrant(
  overrides: Partial<CustomerProductGrant> = {},
): CustomerProductGrant {
  return {
    version: 1,
    grantId: "grant-registry-self",
    licenseId: "license-registry-001",
    customerId: "customer-registry-001",
    productMode: "SELF_MANAGED",
    installationId: "install-registry-001",
    allowedBotModes: ["PAUSE", "AUTO"],
    allowedCopySizingModes: [],
    issuedAt: NOW - 10_000,
    expiresAt: NOW + 50_000,
    ...overrides,
  };
}

function copyGrant(
  overrides: Partial<CustomerProductGrant> = {},
): CustomerProductGrant {
  return {
    version: 1,
    grantId: "grant-registry-copy",
    licenseId: "license-registry-002",
    customerId: "customer-registry-002",
    productMode: "COPY_FOLLOWER",
    installationId: "install-registry-002",
    allowedBotModes: [],
    allowedCopySizingModes: ["EQUITY_RATIO"],
    issuedAt: NOW - 10_000,
    expiresAt: NOW + 50_000,
    ...overrides,
  };
}

function lifecycle(
  grant: CustomerProductGrant,
): CustomerProductGrantLifecycleRecord {
  return createCustomerProductGrantLifecycle(grant);
}

describe("customer grant registration", () => {
  it("registers an ACTIVE revision-1 lifecycle record", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();
    const source = lifecycle(selfGrant());

    const decision = await registerCustomerGrant(repository, source);

    expect(decision).toMatchObject({
      ok: true,
      code: "REGISTERED",
      record: {
        status: "ACTIVE",
        revision: 1,
        grant: { grantId: "grant-registry-self" },
      },
    });

    const stored = await repository.get("grant-registry-self");
    expect(stored).toEqual(source);
    expect(stored).not.toBe(source);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored?.grant)).toBe(true);
    expect(Object.isFrozen(stored?.grant.allowedBotModes)).toBe(true);
  });

  it("treats exact repeated registration as idempotent", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();
    const source = lifecycle(selfGrant());

    await expect(
      registerCustomerGrant(repository, source),
    ).resolves.toMatchObject({ ok: true, code: "REGISTERED" });

    await expect(
      registerCustomerGrant(repository, source),
    ).resolves.toMatchObject({ ok: true, code: "ALREADY_REGISTERED" });
  });

  it("rejects a conflicting grant reusing an existing grantId", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();

    await registerCustomerGrant(repository, lifecycle(selfGrant()));

    const conflicting = lifecycle(
      selfGrant({
        customerId: "customer-registry-other",
      }),
    );

    await expect(
      registerCustomerGrant(repository, conflicting),
    ).resolves.toEqual({ ok: false, code: "GRANT_ID_CONFLICT" });
  });

  it("rejects a revoked record as an initial registration state", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();
    const revoked = revokeCustomerProductGrant(
      lifecycle(selfGrant()),
      NOW - 1,
    );

    await expect(
      registerCustomerGrant(repository, revoked),
    ).resolves.toEqual({ ok: false, code: "INVALID_INITIAL_STATE" });
  });
});

describe("customer grant revocation", () => {
  it("revokes once and preserves the first revocation timestamp", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();
    await registerCustomerGrant(repository, lifecycle(selfGrant()));

    const first = await revokeRegisteredCustomerGrant(
      repository,
      "grant-registry-self",
      NOW - 1,
    );
    const repeated = await revokeRegisteredCustomerGrant(
      repository,
      "grant-registry-self",
      NOW + 500,
    );

    expect(first).toMatchObject({
      ok: true,
      code: "REVOKED",
      record: {
        status: "REVOKED",
        revokedAt: NOW - 1,
        revision: 2,
      },
    });
    expect(repeated).toMatchObject({
      ok: true,
      code: "ALREADY_REVOKED",
      record: {
        revokedAt: NOW - 1,
        revision: 2,
      },
    });
  });

  it("returns NOT_FOUND without creating registry state", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();

    await expect(
      revokeRegisteredCustomerGrant(repository, "missing-grant", NOW),
    ).resolves.toEqual({ ok: false, code: "NOT_FOUND" });

    await expect(repository.list()).resolves.toEqual([]);
  });

  it("fails closed on an optimistic revision conflict", async () => {
    const source = lifecycle(selfGrant());

    const repository: CustomerGrantRegistryRepository = {
      async get() {
        return source;
      },
      async compareAndSet() {
        return false;
      },
      async list() {
        return [source];
      },
    };

    await expect(
      revokeRegisteredCustomerGrant(
        repository,
        "grant-registry-self",
        NOW - 1,
      ),
    ).resolves.toEqual({ ok: false, code: "REVISION_CONFLICT" });
  });
});

describe("customer grant admin views", () => {
  it("returns flattened effective status without duplicating license state", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();
    await registerCustomerGrant(repository, lifecycle(selfGrant()));

    const view = await getCustomerGrantAdminView(
      repository,
      "grant-registry-self",
      NOW,
    );

    expect(view).toEqual({
      version: 1,
      grantId: "grant-registry-self",
      licenseId: "license-registry-001",
      customerId: "customer-registry-001",
      productMode: "SELF_MANAGED",
      installationId: "install-registry-001",
      allowedBotModes: ["PAUSE", "AUTO"],
      allowedCopySizingModes: [],
      issuedAt: NOW - 10_000,
      expiresAt: NOW + 50_000,
      lifecycleStatus: "ACTIVE",
      revokedAt: null,
      revision: 1,
      effectiveStatus: "ACTIVE",
    });
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view?.allowedBotModes)).toBe(true);
  });

  it("filters deterministically by customer, installation, mode and lifecycle", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();

    await registerCustomerGrant(
      repository,
      lifecycle(
        selfGrant({
          grantId: "grant-z-self",
          customerId: "customer-shared",
          installationId: "install-shared",
        }),
      ),
    );
    await registerCustomerGrant(
      repository,
      lifecycle(
        copyGrant({
          grantId: "grant-a-copy",
          customerId: "customer-shared",
          installationId: "install-shared",
        }),
      ),
    );

    await revokeRegisteredCustomerGrant(
      repository,
      "grant-z-self",
      NOW - 1,
    );

    const shared = await listCustomerGrantAdminViews(
      repository,
      {
        customerId: "customer-shared",
        installationId: "install-shared",
      },
      NOW,
    );
    expect(shared.map((item) => item.grantId)).toEqual([
      "grant-a-copy",
      "grant-z-self",
    ]);

    const revokedSelfManaged = await listCustomerGrantAdminViews(
      repository,
      {
        productMode: "SELF_MANAGED",
        lifecycleStatus: "REVOKED",
      },
      NOW,
    );
    expect(revokedSelfManaged).toHaveLength(1);
    expect(revokedSelfManaged[0]).toMatchObject({
      grantId: "grant-z-self",
      effectiveStatus: "REVOKED",
    });
  });

  it("derives EXPIRED from the grant window at query time", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();
    await registerCustomerGrant(repository, lifecycle(copyGrant()));

    const view = await getCustomerGrantAdminView(
      repository,
      "grant-registry-copy",
      NOW + 50_000,
    );

    expect(view?.effectiveStatus).toBe("EXPIRED");
    expect(view?.lifecycleStatus).toBe("ACTIVE");
  });
});
