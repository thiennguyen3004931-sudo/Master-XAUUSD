import { describe, expect, it } from "vitest";
import type { LicenseRecord } from "@xauusd/license-service";
import {
  authorizeCopyFollowerLifecycleAccess,
  authorizeSelfManagedLifecycleAccess,
  assertCustomerProductGrantLifecycleRecord,
  createCustomerProductGrantLifecycle,
  effectiveCustomerGrantStatus,
  revokeCustomerProductGrant,
} from "./grant-lifecycle.js";
import {
  issueCopyFollowerGrant,
  issueSelfManagedGrant,
} from "./provisioning.js";

const NOW = 4_000_000;

function license(overrides: Partial<LicenseRecord> = {}): LicenseRecord {
  return {
    licenseId: "lic-life-001",
    status: "ACTIVE",
    customerId: "customer-life-001",
    allowedMt5Logins: [991001],
    allowedBrokerServers: ["Broker-Real"],
    installationId: "install-life-001",
    installationPublicKey: "public-key",
    plan: "CUSTOMER_V1",
    maxAccounts: 1,
    issuedAt: NOW - 100_000,
    expiresAt: NOW + 100_000,
    revokedAt: null,
    ...overrides,
  };
}

function selfGrant() {
  return issueSelfManagedGrant(license(), {
    grantId: "grant-life-self",
    issuedAt: NOW - 10_000,
    expiresAt: NOW + 50_000,
    allowedBotModes: ["AUTO", "SEMI"],
  });
}

function copyGrant() {
  return issueCopyFollowerGrant(license(), {
    grantId: "grant-life-copy",
    issuedAt: NOW - 10_000,
    expiresAt: NOW + 50_000,
    allowedCopySizingModes: ["EQUITY_RATIO", "FIXED_LOT"],
  });
}

describe("customer grant lifecycle record", () => {
  it("wraps a valid product grant as an immutable ACTIVE revision 1 snapshot", () => {
    const source = selfGrant();
    const record = createCustomerProductGrantLifecycle(source);

    expect(record).toMatchObject({
      version: 1,
      status: "ACTIVE",
      revokedAt: null,
      revision: 1,
      grant: {
        grantId: "grant-life-self",
        productMode: "SELF_MANAGED",
      },
    });
    expect(record.grant).not.toBe(source);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.grant)).toBe(true);
    expect(Object.isFrozen(record.grant.allowedBotModes)).toBe(true);
    expect(Object.isFrozen(record.grant.allowedCopySizingModes)).toBe(true);
  });

  it("reports not-yet-valid, active and expired windows", () => {
    const record = createCustomerProductGrantLifecycle(selfGrant());

    expect(
      effectiveCustomerGrantStatus(record, record.grant.issuedAt - 1),
    ).toBe("NOT_YET_VALID");
    expect(effectiveCustomerGrantStatus(record, NOW)).toBe("ACTIVE");
    expect(
      effectiveCustomerGrantStatus(record, record.grant.expiresAt),
    ).toBe("EXPIRED");
  });

  it("preserves the first revocation timestamp and is idempotent", () => {
    const active = createCustomerProductGrantLifecycle(selfGrant());
    const revoked = revokeCustomerProductGrant(active, NOW + 100);
    const repeated = revokeCustomerProductGrant(revoked, NOW + 999);

    expect(revoked).toMatchObject({
      status: "REVOKED",
      revokedAt: NOW + 100,
      revision: 2,
    });
    expect(repeated).toBe(revoked);
    expect(repeated.revokedAt).toBe(NOW + 100);
    expect(repeated.revision).toBe(2);
  });

  it("rejects revocation before grant issuance", () => {
    const active = createCustomerProductGrantLifecycle(selfGrant());

    expect(() =>
      revokeCustomerProductGrant(active, active.grant.issuedAt - 1),
    ).toThrow(/must not be earlier/);
  });

  it("rejects malformed and unknown lifecycle fields", () => {
    const active = createCustomerProductGrantLifecycle(selfGrant());

    expect(() =>
      assertCustomerProductGrantLifecycleRecord({
        ...active,
        unknownField: true,
      }),
    ).toThrow(/unknown field/);

    expect(() =>
      assertCustomerProductGrantLifecycleRecord({
        ...active,
        status: "REVOKED",
        revokedAt: null,
      }),
    ).toThrow(/revision|revokedAt/);

    expect(() =>
      assertCustomerProductGrantLifecycleRecord({
        ...active,
        revision: 2,
      }),
    ).toThrow(/revision must be 1/);

    expect(() =>
      assertCustomerProductGrantLifecycleRecord({
        ...active,
        status: "REVOKED",
        revokedAt: NOW,
        revision: 1,
      }),
    ).toThrow(/at least 2/);
  });
});

describe("SELF_MANAGED lifecycle authorization", () => {
  it("blocks new exposure after revocation", () => {
    const parent = license();
    const record = revokeCustomerProductGrant(
      createCustomerProductGrantLifecycle(selfGrant()),
      NOW - 1,
    );

    expect(
      authorizeSelfManagedLifecycleAccess(parent, record, {
        installationId: "install-life-001",
        mt5Login: 991001,
        brokerServer: "Broker-Real",
        now: NOW,
        requestedBotMode: "AUTO",
      }),
    ).toMatchObject({
      ok: false,
      code: "GRANT_REVOKED",
      productMode: "SELF_MANAGED",
    });
  });

  it("keeps PAUSE available after revocation when binding is valid", () => {
    const parent = license();
    const record = revokeCustomerProductGrant(
      createCustomerProductGrantLifecycle(selfGrant()),
      NOW - 1,
    );

    expect(
      authorizeSelfManagedLifecycleAccess(parent, record, {
        installationId: "install-life-001",
        mt5Login: 991001,
        brokerServer: "Broker-Real",
        now: NOW,
        requestedBotMode: "PAUSE",
      }),
    ).toMatchObject({
      ok: true,
      code: "AUTHORIZED_SAFE_PAUSE",
      exposureAllowed: false,
    });
  });

  it("does not hide installation mismatch behind revocation", () => {
    const parent = license();
    const record = revokeCustomerProductGrant(
      createCustomerProductGrantLifecycle(selfGrant()),
      NOW - 1,
    );

    expect(
      authorizeSelfManagedLifecycleAccess(parent, record, {
        installationId: "copied-install",
        mt5Login: 991001,
        brokerServer: "Broker-Real",
        now: NOW,
        requestedBotMode: "AUTO",
      }),
    ).toMatchObject({
      ok: false,
      code: "INSTALLATION_MISMATCH",
    });
  });

  it("keeps original authorization before a future revocation timestamp", () => {
    const parent = license();
    const record = revokeCustomerProductGrant(
      createCustomerProductGrantLifecycle(selfGrant()),
      NOW + 1_000,
    );

    expect(effectiveCustomerGrantStatus(record, NOW)).toBe("ACTIVE");
    expect(
      authorizeSelfManagedLifecycleAccess(parent, record, {
        installationId: "install-life-001",
        mt5Login: 991001,
        brokerServer: "Broker-Real",
        now: NOW,
        requestedBotMode: "AUTO",
      }),
    ).toMatchObject({
      ok: true,
      code: "AUTHORIZED",
      exposureAllowed: true,
    });
  });
});

describe("COPY_FOLLOWER lifecycle authorization", () => {
  it("blocks new copy exposure after revocation", () => {
    const parent = license();
    const record = revokeCustomerProductGrant(
      createCustomerProductGrantLifecycle(copyGrant()),
      NOW - 1,
    );

    expect(
      authorizeCopyFollowerLifecycleAccess(parent, record, {
        installationId: "install-life-001",
        mt5Login: 991001,
        brokerServer: "Broker-Real",
        now: NOW,
        requestedSizingMode: "EQUITY_RATIO",
      }),
    ).toMatchObject({
      ok: false,
      code: "GRANT_REVOKED",
      productMode: "COPY_FOLLOWER",
    });
  });

  it("authorizes before a future revocation becomes effective", () => {
    const parent = license();
    const record = revokeCustomerProductGrant(
      createCustomerProductGrantLifecycle(copyGrant()),
      NOW + 1_000,
    );

    expect(
      authorizeCopyFollowerLifecycleAccess(parent, record, {
        installationId: "install-life-001",
        mt5Login: 991001,
        brokerServer: "Broker-Real",
        now: NOW,
        requestedSizingMode: "FIXED_LOT",
      }),
    ).toMatchObject({
      ok: true,
      code: "AUTHORIZED",
      exposureAllowed: true,
    });
  });
});
