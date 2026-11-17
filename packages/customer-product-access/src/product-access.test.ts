import { describe, expect, it } from "vitest";
import type { LicenseRecord } from "@xauusd/license-service";
import {
  assertCustomerProductGrant,
  authorizeCopyFollowerAccess,
  authorizeSelfManagedAccess,
  type CustomerProductGrant,
} from "./product-access.js";

const NOW = 2_000_000;

function license(overrides: Partial<LicenseRecord> = {}): LicenseRecord {
  return {
    licenseId: "lic-001",
    status: "ACTIVE",
    customerId: "customer-001",
    allowedMt5Logins: [123456],
    allowedBrokerServers: ["Broker-Real"],
    installationId: "install-001",
    installationPublicKey: "public-key",
    plan: "CUSTOMER_V1",
    maxAccounts: 1,
    issuedAt: NOW - 100_000,
    expiresAt: NOW + 100_000,
    revokedAt: null,
    ...overrides,
  };
}

function selfManagedGrant(
  overrides: Partial<CustomerProductGrant> = {},
): CustomerProductGrant {
  return {
    version: 1,
    grantId: "grant-self-001",
    licenseId: "lic-001",
    customerId: "customer-001",
    productMode: "SELF_MANAGED",
    installationId: "install-001",
    allowedBotModes: ["PAUSE", "AUTO", "SEMI"],
    allowedCopySizingModes: [],
    issuedAt: NOW - 50_000,
    expiresAt: NOW + 50_000,
    ...overrides,
  };
}

function copyGrant(
  overrides: Partial<CustomerProductGrant> = {},
): CustomerProductGrant {
  return {
    version: 1,
    grantId: "grant-copy-001",
    licenseId: "lic-001",
    customerId: "customer-001",
    productMode: "COPY_FOLLOWER",
    installationId: "install-001",
    allowedBotModes: [],
    allowedCopySizingModes: ["EQUITY_RATIO", "LOT_MULTIPLIER"],
    issuedAt: NOW - 50_000,
    expiresAt: NOW + 50_000,
    ...overrides,
  };
}

const base = {
  installationId: "install-001",
  mt5Login: 123456,
  brokerServer: "Broker-Real",
  now: NOW,
};

describe("customer product grant schema", () => {
  it("accepts an explicit self-managed grant", () => {
    expect(() => assertCustomerProductGrant(selfManagedGrant())).not.toThrow();
  });

  it("accepts an explicit copy follower grant", () => {
    expect(() => assertCustomerProductGrant(copyGrant())).not.toThrow();
  });

  it("requires PAUSE for self-managed safety control", () => {
    expect(() =>
      assertCustomerProductGrant(
        selfManagedGrant({ allowedBotModes: ["AUTO"] }),
      ),
    ).toThrow(/must always allow PAUSE/);
  });

  it("does not let self-managed and copy entitlements bleed together", () => {
    expect(() =>
      assertCustomerProductGrant(
        selfManagedGrant({
          allowedCopySizingModes: ["FIXED_LOT"],
        }),
      ),
    ).toThrow(/must not contain copy follower sizing modes/);

    expect(() =>
      assertCustomerProductGrant(
        copyGrant({
          allowedBotModes: ["PAUSE"],
        }),
      ),
    ).toThrow(/must not contain bot modes/);
  });
});

describe("SELF_MANAGED authorization", () => {
  it("allows an active licensed customer to enable an allowlisted bot mode", () => {
    expect(
      authorizeSelfManagedAccess(license(), selfManagedGrant(), {
        ...base,
        requestedBotMode: "AUTO",
      }),
    ).toEqual({
      ok: true,
      code: "AUTHORIZED",
      productMode: "SELF_MANAGED",
      effectiveLicenseStatus: "ACTIVE",
      exposureAllowed: true,
    });
  });

  it("allows PAUSE as a safety action even after license expiry", () => {
    expect(
      authorizeSelfManagedAccess(
        license({ expiresAt: NOW - 1 }),
        selfManagedGrant({
          issuedAt: NOW - 100_000,
          expiresAt: NOW - 1,
        }),
        {
          ...base,
          requestedBotMode: "PAUSE",
        },
      ),
    ).toEqual({
      ok: true,
      code: "AUTHORIZED_SAFE_PAUSE",
      productMode: "SELF_MANAGED",
      effectiveLicenseStatus: "EXPIRED",
      exposureAllowed: false,
    });
  });

  it("blocks new exposure modes when the license is not active", () => {
    const decision = authorizeSelfManagedAccess(
      license({ status: "SUSPENDED" }),
      selfManagedGrant(),
      {
        ...base,
        requestedBotMode: "AUTO",
      },
    );
    expect(decision).toMatchObject({
      ok: false,
      code: "LICENSE_NOT_ACTIVE",
      productMode: "SELF_MANAGED",
      effectiveLicenseStatus: "SUSPENDED",
    });
  });

  it("blocks a bot mode not allowed by the customer's plan", () => {
    const decision = authorizeSelfManagedAccess(
      license(),
      selfManagedGrant({ allowedBotModes: ["PAUSE", "SEMI"] }),
      {
        ...base,
        requestedBotMode: "AUTO",
      },
    );
    expect(decision).toMatchObject({
      ok: false,
      code: "BOT_MODE_NOT_ALLOWED",
    });
  });

  it("fails closed on installation, MT5 login, and broker mismatches", () => {
    expect(
      authorizeSelfManagedAccess(license(), selfManagedGrant(), {
        ...base,
        installationId: "copied-install",
        requestedBotMode: "AUTO",
      }),
    ).toMatchObject({ ok: false, code: "INSTALLATION_MISMATCH" });

    expect(
      authorizeSelfManagedAccess(license(), selfManagedGrant(), {
        ...base,
        mt5Login: 999999,
        requestedBotMode: "AUTO",
      }),
    ).toMatchObject({ ok: false, code: "MT5_LOGIN_NOT_ALLOWED" });

    expect(
      authorizeSelfManagedAccess(license(), selfManagedGrant(), {
        ...base,
        brokerServer: "Other-Broker",
        requestedBotMode: "AUTO",
      }),
    ).toMatchObject({ ok: false, code: "BROKER_SERVER_NOT_ALLOWED" });
  });

  it("rejects a copy follower grant at the self-managed boundary", () => {
    expect(
      authorizeSelfManagedAccess(license(), copyGrant(), {
        ...base,
        requestedBotMode: "AUTO",
      }),
    ).toMatchObject({ ok: false, code: "PRODUCT_MODE_MISMATCH" });
  });
});

describe("COPY_FOLLOWER authorization", () => {
  it("allows an active licensed follower to use an allowlisted sizing mode", () => {
    expect(
      authorizeCopyFollowerAccess(license(), copyGrant(), {
        ...base,
        requestedSizingMode: "EQUITY_RATIO",
      }),
    ).toEqual({
      ok: true,
      code: "AUTHORIZED",
      productMode: "COPY_FOLLOWER",
      effectiveLicenseStatus: "ACTIVE",
      exposureAllowed: true,
    });
  });

  it("blocks a sizing mode not granted to that follower", () => {
    expect(
      authorizeCopyFollowerAccess(license(), copyGrant(), {
        ...base,
        requestedSizingMode: "FIXED_LOT",
      }),
    ).toMatchObject({ ok: false, code: "SIZING_MODE_NOT_ALLOWED" });
  });

  it("blocks copy follower new exposure after grant expiry", () => {
    expect(
      authorizeCopyFollowerAccess(
        license(),
        copyGrant({ expiresAt: NOW }),
        {
          ...base,
          requestedSizingMode: "EQUITY_RATIO",
        },
      ),
    ).toMatchObject({ ok: false, code: "GRANT_EXPIRED" });
  });

  it("rejects self-managed grant at the copy follower boundary", () => {
    expect(
      authorizeCopyFollowerAccess(license(), selfManagedGrant(), {
        ...base,
        requestedSizingMode: "EQUITY_RATIO",
      }),
    ).toMatchObject({ ok: false, code: "PRODUCT_MODE_MISMATCH" });
  });
});

describe("license/grant binding", () => {
  it("rejects a grant copied to another customer or license", () => {
    expect(
      authorizeSelfManagedAccess(
        license(),
        selfManagedGrant({ customerId: "other-customer" }),
        {
          ...base,
          requestedBotMode: "AUTO",
        },
      ),
    ).toMatchObject({ ok: false, code: "LICENSE_GRANT_MISMATCH" });

    expect(
      authorizeCopyFollowerAccess(
        license(),
        copyGrant({ licenseId: "other-license" }),
        {
          ...base,
          requestedSizingMode: "EQUITY_RATIO",
        },
      ),
    ).toMatchObject({ ok: false, code: "LICENSE_GRANT_MISMATCH" });
  });

  it("rejects a product grant whose validity exceeds the parent license", () => {
    expect(
      authorizeSelfManagedAccess(
        license(),
        selfManagedGrant({ expiresAt: NOW + 200_000 }),
        {
          ...base,
          requestedBotMode: "AUTO",
        },
      ),
    ).toMatchObject({ ok: false, code: "LICENSE_GRANT_MISMATCH" });
  });
});
