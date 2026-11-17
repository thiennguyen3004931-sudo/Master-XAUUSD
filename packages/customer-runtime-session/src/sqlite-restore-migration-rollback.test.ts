import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCustomerProductGrantLifecycle,
  issueSelfManagedGrant,
} from "@xauusd/customer-product-access";
import {
  createInstallationChallenge,
  exportInstallationPublicKey,
  generateInstallationDeviceKeyPair,
} from "@xauusd/installation-proof";
import type { LicenseRecord } from "@xauusd/license-service";
import { SqliteCustomerSecurityStore } from "./sqlite-store.js";

// P0 #176: all records and files in this test are disposable and synthetic.
// A PASS is evidence of an UNSAFE old-backup replay, not restore acceptance.
const NOW = 60_000_000;
const directories: string[] = [];

function makePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "xauusd-rollback-witness-"));
  directories.push(dir);
  return join(dir, "synthetic-security.sqlite");
}

function makeLicense(
  licenseId: string,
  installationId: string,
  publicKey: string,
): LicenseRecord {
  return {
    licenseId,
    status: "ACTIVE",
    customerId: "synthetic-customer-restore-001",
    allowedMt5Logins: [991001],
    allowedBrokerServers: ["Broker-Test"],
    installationId,
    installationPublicKey: publicKey,
    plan: "CUSTOMER_V1",
    maxAccounts: 1,
    issuedAt: NOW - 100_000,
    expiresAt: NOW + 1_000_000,
    revokedAt: null,
  };
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

describe("P0 physical SQLite rollback witness — installation migration", () => {
  it("shows old closed snapshots can resurrect consumed challenge and omit a committed migration audit", async () => {
    const livePath = makePath();
    const stalePath = livePath.replace(".sqlite", "-old-closed-copy.sqlite");
    const oldKeys = generateInstallationDeviceKeyPair();
    const newKeys = generateInstallationDeviceKeyPair();
    const oldLicense = makeLicense(
      "synthetic-old-license",
      "synthetic-old-installation",
      exportInstallationPublicKey(oldKeys.publicKey),
    );
    const newLicense = makeLicense(
      "synthetic-new-license",
      "synthetic-new-installation",
      exportInstallationPublicKey(newKeys.publicKey),
    );
    const oldGrant = createCustomerProductGrantLifecycle(
      issueSelfManagedGrant(oldLicense, {
        grantId: "synthetic-old-grant",
        issuedAt: NOW - 1_000,
        expiresAt: NOW + 500_000,
        allowedBotModes: ["AUTO"],
      }),
    );
    const newGrant = createCustomerProductGrantLifecycle(
      issueSelfManagedGrant(newLicense, {
        grantId: "synthetic-new-grant",
        issuedAt: NOW,
        expiresAt: NOW + 500_000,
        allowedBotModes: ["AUTO"],
      }),
    );
    const challenge = createInstallationChallenge({
      purpose: "RECONNECT",
      licenseId: oldLicense.licenseId,
      installationId: oldLicense.installationId,
      now: NOW - 100,
      ttlMs: 60_000,
    });

    const before = new SqliteCustomerSecurityStore(livePath);
    await before.licenses.put(oldLicense);
    expect(await before.grants.compareAndSet(
      oldGrant.grant.grantId,
      null,
      oldGrant,
    )).toBe(true);
    expect(await before.challenges.put(challenge)).toBe(true);
    expect(await before.listInstallationMigrationAudit()).toHaveLength(0);
    before.close();

    // ONLY a fully CLOSED disposable database is copied here. Never copy
    // customer DB/WAL or interpret this as a production backup procedure.
    copyFileSync(livePath, stalePath);

    const updated = new SqliteCustomerSecurityStore(livePath);
    const decision = await updated.migrateInstallation({
      oldGrantId: oldGrant.grant.grantId,
      newLicense,
      newGrant,
      migratedAt: NOW,
      authorizedBy: "synthetic-operator",
    });
    expect(decision).toMatchObject({
      ok: true,
      code: "MIGRATED",
      invalidatedChallenges: 1,
    });
    expect(await updated.listInstallationMigrationAudit(
      oldLicense.customerId,
    )).toHaveLength(1);
    expect(await updated.challenges.consume(challenge.challengeId, NOW + 1))
      .toBe(false);
    updated.close();

    // Independent old copy has neither the migrated binding nor its audit;
    // challenge replay succeeds although the actual current DB rejects it.
    const stale = new SqliteCustomerSecurityStore(stalePath);
    await expect(stale.licenses.get(oldLicense.licenseId))
      .resolves.toMatchObject({ status: "ACTIVE" });
    await expect(stale.grants.get(oldGrant.grant.grantId))
      .resolves.toMatchObject({ status: "ACTIVE" });
    await expect(stale.licenses.get(newLicense.licenseId))
      .resolves.toBeNull();
    await expect(stale.grants.get(newGrant.grant.grantId))
      .resolves.toBeNull();
    expect(await stale.listInstallationMigrationAudit(
      oldLicense.customerId,
    )).toHaveLength(0);
    expect(await stale.challenges.consume(challenge.challengeId, NOW + 1))
      .toBe(true);
    stale.close();

    const current = new SqliteCustomerSecurityStore(livePath);
    await expect(current.licenses.get(oldLicense.licenseId))
      .resolves.toMatchObject({ status: "REVOKED" });
    await expect(current.grants.get(oldGrant.grant.grantId))
      .resolves.toMatchObject({ status: "REVOKED" });
    await expect(current.licenses.get(newLicense.licenseId))
      .resolves.toMatchObject({ status: "ACTIVE" });
    expect(await current.listInstallationMigrationAudit(
      oldLicense.customerId,
    )).toHaveLength(1);
    expect(await current.challenges.consume(challenge.challengeId, NOW + 1))
      .toBe(false);
    current.close();
  });
});
