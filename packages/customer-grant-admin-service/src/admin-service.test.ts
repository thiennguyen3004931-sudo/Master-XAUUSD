import { describe, expect, it } from "vitest";
import {
  InMemoryCustomerGrantRegistryRepository,
  type CustomerGrantRegistryRepository,
} from "@xauusd/customer-grant-registry";
import {
  createCustomerProductGrantLifecycle,
  type CustomerProductGrant,
} from "@xauusd/customer-product-access";
import {
  executeCustomerGrantAdminCommand,
  type CustomerGrantAdminAuthorizationRequest,
  type CustomerGrantAdminAuthorizer,
} from "./admin-service.js";

const NOW = 6_000_000;

function grant(overrides: Partial<CustomerProductGrant> = {}): CustomerProductGrant {
  return {
    version: 1,
    grantId: "grant-admin-001",
    licenseId: "license-admin-001",
    customerId: "customer-admin-001",
    productMode: "SELF_MANAGED",
    installationId: "install-admin-001",
    allowedBotModes: ["PAUSE", "AUTO"],
    allowedCopySizingModes: [],
    issuedAt: NOW - 10_000,
    expiresAt: NOW + 50_000,
    ...overrides,
  };
}

function allowAll(
  seen: CustomerGrantAdminAuthorizationRequest[] = [],
): CustomerGrantAdminAuthorizer {
  return {
    async authorize(request) {
      seen.push(request);
      return true;
    },
  };
}

describe("customer grant admin command service", () => {
  it("denies before any repository access when authorization fails", async () => {
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

    const result = await executeCustomerGrantAdminCommand(
      repository,
      { async authorize() { return false; } },
      { subjectId: "admin-001" },
      {
        version: 1,
        operation: "GET_GRANT",
        grantId: "grant-admin-001",
        now: NOW,
      },
    );

    expect(result).toEqual({ ok: false, code: "ADMIN_FORBIDDEN" });
    expect(repositoryCalls).toBe(0);
  });

  it("rejects malformed actor and command before authorization", async () => {
    let authorizeCalls = 0;
    const authorizer: CustomerGrantAdminAuthorizer = {
      async authorize() {
        authorizeCalls += 1;
        return true;
      },
    };
    const repository = new InMemoryCustomerGrantRegistryRepository();

    await expect(
      executeCustomerGrantAdminCommand(
        repository,
        authorizer,
        { subjectId: " admin " },
        {
          version: 1,
          operation: "GET_GRANT",
          grantId: "grant-admin-001",
          now: NOW,
        },
      ),
    ).resolves.toEqual({ ok: false, code: "INVALID_ADMIN_ACTOR" });

    await expect(
      executeCustomerGrantAdminCommand(
        repository,
        authorizer,
        { subjectId: "admin-001" },
        {
          version: 1,
          operation: "GET_GRANT",
          grantId: "grant-admin-001",
          now: NOW,
          unknown: true,
        },
      ),
    ).resolves.toEqual({ ok: false, code: "INVALID_COMMAND" });

    await expect(
      executeCustomerGrantAdminCommand(
        repository,
        authorizer,
        { subjectId: "admin-001" },
        {
          version: 1,
          operation: "LIST_GRANTS",
          query: { unknown: true },
          now: NOW,
        },
      ),
    ).resolves.toEqual({ ok: false, code: "INVALID_COMMAND" });

    await expect(
      executeCustomerGrantAdminCommand(
        repository,
        authorizer,
        { subjectId: "admin-001" },
        {
          version: 1,
          operation: "REGISTER_GRANT",
          lifecycle: {
            version: 1,
            grant: { grantId: "malformed" },
            status: "ACTIVE",
            revokedAt: null,
            revision: 1,
          },
          now: NOW,
        },
      ),
    ).resolves.toEqual({ ok: false, code: "INVALID_COMMAND" });

    expect(authorizeCalls).toBe(0);
  });

  it("registers, reads, lists and revokes through explicit admin actions", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();
    const seen: CustomerGrantAdminAuthorizationRequest[] = [];
    const authorizer = allowAll(seen);
    const lifecycle = createCustomerProductGrantLifecycle(grant());
    const actor = { subjectId: "admin-001" };

    await expect(
      executeCustomerGrantAdminCommand(repository, authorizer, actor, {
        version: 1,
        operation: "REGISTER_GRANT",
        lifecycle,
        now: NOW,
      }),
    ).resolves.toMatchObject({
      ok: true,
      code: "REGISTER_DECISION",
      decision: { ok: true, code: "REGISTERED" },
    });

    await expect(
      executeCustomerGrantAdminCommand(repository, authorizer, actor, {
        version: 1,
        operation: "GET_GRANT",
        grantId: lifecycle.grant.grantId,
        now: NOW,
      }),
    ).resolves.toMatchObject({
      ok: true,
      code: "GRANT_READ",
      view: { grantId: lifecycle.grant.grantId, effectiveStatus: "ACTIVE" },
    });

    await expect(
      executeCustomerGrantAdminCommand(repository, authorizer, actor, {
        version: 1,
        operation: "LIST_GRANTS",
        query: { customerId: lifecycle.grant.customerId },
        now: NOW,
      }),
    ).resolves.toMatchObject({
      ok: true,
      code: "GRANTS_LISTED",
      views: [{ grantId: lifecycle.grant.grantId }],
    });

    await expect(
      executeCustomerGrantAdminCommand(repository, authorizer, actor, {
        version: 1,
        operation: "REVOKE_GRANT",
        grantId: lifecycle.grant.grantId,
        revokedAt: NOW,
        now: NOW,
      }),
    ).resolves.toMatchObject({
      ok: true,
      code: "REVOKE_DECISION",
      decision: { ok: true, code: "REVOKED" },
    });

    expect(seen.map((request) => request.action)).toEqual([
      "REGISTER_GRANT",
      "READ_GRANT",
      "LIST_GRANTS",
      "REVOKE_GRANT",
    ]);
  });

  it("passes the target grantId to authorization for targeted actions", async () => {
    const repository = new InMemoryCustomerGrantRegistryRepository();
    const seen: CustomerGrantAdminAuthorizationRequest[] = [];
    const authorizer = allowAll(seen);
    const lifecycle = createCustomerProductGrantLifecycle(grant());

    await executeCustomerGrantAdminCommand(
      repository,
      authorizer,
      { subjectId: "admin-001" },
      {
        version: 1,
        operation: "REGISTER_GRANT",
        lifecycle,
        now: NOW,
      },
    );

    expect(seen[0]).toEqual({
      actor: { subjectId: "admin-001" },
      action: "REGISTER_GRANT",
      grantId: "grant-admin-001",
    });
  });
});
