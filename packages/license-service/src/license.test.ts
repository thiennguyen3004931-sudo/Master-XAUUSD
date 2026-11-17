import { describe, expect, it } from "vitest";
import {
  LICENSE_STATUSES,
  assertLicenseRecord,
  effectiveLicenseStatus
} from "./license.js";

const validLicense = {
  licenseId: "lic-0001",
  status: "ACTIVE",
  customerId: "cust-0001",
  allowedMt5Logins: [12345678],
  allowedBrokerServers: ["Broker-Live"],
  installationId: "inst-0001",
  installationPublicKey: "device-public-key-placeholder",
  plan: "STANDARD",
  maxAccounts: 1,
  issuedAt: 1_789_000_000_000,
  expiresAt: 1_791_592_000_000,
  revokedAt: null
} as const;

describe("license model", () => {
  it("locks exact V1 statuses", () => {
    expect(LICENSE_STATUSES).toEqual([
      "ACTIVE",
      "SUSPENDED",
      "EXPIRED",
      "REVOKED"
    ]);
  });

  it("accepts a canonical active license", () => {
    expect(() => assertLicenseRecord(validLicense)).not.toThrow();
  });

  it.each([
    [{ ...validLicense, allowedMt5Logins: [] }, "allowedMt5Logins"],
    [{ ...validLicense, allowedMt5Logins: [12345678, 12345678] }, "duplicate"],
    [{ ...validLicense, allowedBrokerServers: ["*"] }, "wildcard"],
    [{ ...validLicense, allowedBrokerServers: ["Broker-Live", "Broker-Live"] }, "duplicate"],
    [{ ...validLicense, maxAccounts: 0 }, "maxAccounts"],
    [{ ...validLicense, allowedMt5Logins: [1, 2], maxAccounts: 1 }, "maxAccounts"],
    [{ ...validLicense, expiresAt: validLicense.issuedAt }, "expiresAt"],
    [{ ...validLicense, status: "REVOKED", revokedAt: null }, "revokedAt"],
    [{ ...validLicense, status: "ACTIVE", revokedAt: validLicense.issuedAt + 1 }, "revokedAt"],
    [{ ...validLicense, status: "REVOKED", revokedAt: validLicense.issuedAt - 1 }, "revokedAt"],
    [{ ...validLicense, licenseId: " lic-0001" }, "licenseId"],
    [{ ...validLicense, extra: true }, "unknown field"]
  ])("rejects invalid license record %#", (license, field) => {
    expect(() => assertLicenseRecord(license)).toThrow(field);
  });

  it("treats an elapsed ACTIVE license as effectively EXPIRED", () => {
    expect(effectiveLicenseStatus(validLicense, validLicense.expiresAt)).toBe(
      "EXPIRED"
    );
  });
});
