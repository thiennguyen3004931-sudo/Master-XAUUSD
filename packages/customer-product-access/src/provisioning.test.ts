import { describe, expect, it } from "vitest";
import type { LicenseRecord } from "@xauusd/license-service";
import {
  authorizeCopyFollowerAccess,
  authorizeSelfManagedAccess,
} from "./product-access.js";
import {
  issueCopyFollowerGrant,
  issueSelfManagedGrant,
} from "./provisioning.js";

const NOW = 3_000_000;

function license(overrides: Partial<LicenseRecord> = {}): LicenseRecord {
  return {
    licenseId: "lic-prov-001",
    status: "ACTIVE",
    customerId: "customer-prov-001",
    allowedMt5Logins: [888001],
    allowedBrokerServers: ["Broker-Real"],
    installationId: "install-prov-001",
    installationPublicKey: "public-key",
    plan: "CUSTOMER_V1",
    maxAccounts: 1,
    issuedAt: NOW - 100_000,
    expiresAt: NOW + 100_000,
    revokedAt: null,
    ...overrides,
  };
}

describe("SELF_MANAGED provisioning", () => {
  it("derives parent identity binding and injects PAUSE exactly once", () => {
    const grant = issueSelfManagedGrant(license(), {
      grantId: "grant-self-prov-001",
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 10_000,
      allowedBotModes: ["AUTO", "PAUSE", "SEMI"],
    });

    expect(grant).toEqual({
      version: 1,
      grantId: "grant-self-prov-001",
      licenseId: "lic-prov-001",
      customerId: "customer-prov-001",
      productMode: "SELF_MANAGED",
      installationId: "install-prov-001",
      allowedBotModes: ["PAUSE", "AUTO", "SEMI"],
      allowedCopySizingModes: [],
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 10_000,
    });
  });

  it("allows a PAUSE-only safety grant", () => {
    const grant = issueSelfManagedGrant(license(), {
      grantId: "grant-pause-only",
      issuedAt: NOW,
      expiresAt: NOW + 10_000,
      allowedBotModes: [],
    });

    expect(grant.allowedBotModes).toEqual(["PAUSE"]);
  });

  it("rejects invalid and duplicate bot modes", () => {
    expect(() =>
      issueSelfManagedGrant(license(), {
        grantId: "grant-duplicate",
        issuedAt: NOW,
        expiresAt: NOW + 10_000,
        allowedBotModes: ["AUTO", "AUTO"],
      }),
    ).toThrow(/duplicate/);

    expect(() =>
      issueSelfManagedGrant(license(), {
        grantId: "grant-invalid",
        issuedAt: NOW,
        expiresAt: NOW + 10_000,
        allowedBotModes: ["AUTO", "INVALID" as never],
      }),
    ).toThrow(/invalid value/);
  });

  it("rejects free-form cross-product entitlement fields", () => {
    expect(() =>
      issueSelfManagedGrant(
        license(),
        {
          grantId: "grant-cross-field",
          issuedAt: NOW,
          expiresAt: NOW + 10_000,
          allowedBotModes: ["AUTO"],
          allowedCopySizingModes: ["FIXED_LOT"],
        } as never,
      ),
    ).toThrow(/unknown field/);
  });

  it("issues a grant accepted by the existing runtime authorization layer", () => {
    const parent = license();
    const grant = issueSelfManagedGrant(parent, {
      grantId: "grant-self-runtime",
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 10_000,
      allowedBotModes: ["AUTO"],
    });

    expect(
      authorizeSelfManagedAccess(parent, grant, {
        installationId: "install-prov-001",
        mt5Login: 888001,
        brokerServer: "Broker-Real",
        now: NOW,
        requestedBotMode: "AUTO",
      }),
    ).toMatchObject({ ok: true, code: "AUTHORIZED", exposureAllowed: true });
  });
});

describe("COPY_FOLLOWER provisioning", () => {
  it("issues an isolated sizing grant derived from the parent license", () => {
    const grant = issueCopyFollowerGrant(license(), {
      grantId: "grant-copy-prov-001",
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 10_000,
      allowedCopySizingModes: ["EQUITY_RATIO", "FIXED_LOT"],
    });

    expect(grant).toMatchObject({
      licenseId: "lic-prov-001",
      customerId: "customer-prov-001",
      installationId: "install-prov-001",
      productMode: "COPY_FOLLOWER",
      allowedBotModes: [],
      allowedCopySizingModes: ["EQUITY_RATIO", "FIXED_LOT"],
    });
  });

  it("rejects free-form bot-mode fields at the copy boundary", () => {
    expect(() =>
      issueCopyFollowerGrant(
        license(),
        {
          grantId: "grant-copy-cross-field",
          issuedAt: NOW,
          expiresAt: NOW + 10_000,
          allowedCopySizingModes: ["FIXED_LOT"],
          allowedBotModes: ["AUTO"],
        } as never,
      ),
    ).toThrow(/unknown field/);
  });

  it("requires at least one sizing mode and rejects duplicates", () => {
    expect(() =>
      issueCopyFollowerGrant(license(), {
        grantId: "grant-copy-empty",
        issuedAt: NOW,
        expiresAt: NOW + 10_000,
        allowedCopySizingModes: [],
      }),
    ).toThrow(/must not be empty/);

    expect(() =>
      issueCopyFollowerGrant(license(), {
        grantId: "grant-copy-duplicate",
        issuedAt: NOW,
        expiresAt: NOW + 10_000,
        allowedCopySizingModes: ["FIXED_LOT", "FIXED_LOT"],
      }),
    ).toThrow(/duplicate/);
  });

  it("issues a grant accepted by the existing copy authorization layer", () => {
    const parent = license();
    const grant = issueCopyFollowerGrant(parent, {
      grantId: "grant-copy-runtime",
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 10_000,
      allowedCopySizingModes: ["LOT_MULTIPLIER"],
    });

    expect(
      authorizeCopyFollowerAccess(parent, grant, {
        installationId: "install-prov-001",
        mt5Login: 888001,
        brokerServer: "Broker-Real",
        now: NOW,
        requestedSizingMode: "LOT_MULTIPLIER",
      }),
    ).toMatchObject({ ok: true, code: "AUTHORIZED", exposureAllowed: true });
  });
});

describe("provisioning validity window", () => {
  it("cannot start before or end after the parent license", () => {
    expect(() =>
      issueSelfManagedGrant(license(), {
        grantId: "grant-too-early",
        issuedAt: NOW - 100_001,
        expiresAt: NOW,
        allowedBotModes: ["AUTO"],
      }),
    ).toThrow(/fully contained/);

    expect(() =>
      issueCopyFollowerGrant(license(), {
        grantId: "grant-too-late",
        issuedAt: NOW,
        expiresAt: NOW + 100_001,
        allowedCopySizingModes: ["EQUITY_RATIO"],
      }),
    ).toThrow(/fully contained/);
  });

  it("requires the parent license to be ACTIVE at issuance", () => {
    expect(() =>
      issueSelfManagedGrant(license({ status: "SUSPENDED" }), {
        grantId: "grant-suspended",
        issuedAt: NOW,
        expiresAt: NOW + 10_000,
        allowedBotModes: ["AUTO"],
      }),
    ).toThrow(/must be ACTIVE/);

    expect(() =>
      issueCopyFollowerGrant(
        license({
          status: "REVOKED",
          revokedAt: NOW - 10,
        }),
        {
          grantId: "grant-revoked",
          issuedAt: NOW,
          expiresAt: NOW + 10_000,
          allowedCopySizingModes: ["EQUITY_RATIO"],
        },
      ),
    ).toThrow(/must be ACTIVE/);

    expect(() =>
      issueSelfManagedGrant(
        license({
          issuedAt: NOW - 100_000,
          expiresAt: NOW - 1,
        }),
        {
          grantId: "grant-expired",
          issuedAt: NOW,
          expiresAt: NOW + 10_000,
          allowedBotModes: ["AUTO"],
        },
      ),
    ).toThrow();
  });
});
