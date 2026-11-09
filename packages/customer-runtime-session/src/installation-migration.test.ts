import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCustomerProductGrantLifecycle,
  issueSelfManagedGrant,
} from "@xauusd/customer-product-access";
import {
  exportInstallationPublicKey,
  generateInstallationDeviceKeyPair,
  createInstallationChallenge,
} from "@xauusd/installation-proof";
import type { LicenseRecord } from "@xauusd/license-service";
import { SqliteCustomerSecurityStore } from "./sqlite-store.js";

const NOW = 60_000_000;
const tempDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "xauusd-migration-"));
  tempDirectories.push(directory);
  return join(directory, "customer-security.sqlite");
}

function license(
  licenseId: string,
  installationId: string,
  installationPublicKey: string,
): LicenseRecord {
  return {
    licenseId,
    status: "ACTIVE",
    customerId: "customer-migration-001",
    allowedMt5Logins: [110001],
    allowedBrokerServers: ["Broker-Real"],
    installationId,
    installationPublicKey,
    plan: "CUSTOMER_V1",
    maxAccounts: 1,
    issuedAt: NOW - 100_000,
    expiresAt: NOW + 1_000_000,
    revokedAt: null,
  };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe("customer installation migration", () => {
  it("atomically revokes old binding, invalidates challenges, provisions new binding, and persists audit", async () => {
    const path = databasePath();
    const oldKeys = generateInstallationDeviceKeyPair();
    const newKeys = generateInstallationDeviceKeyPair();
    const oldLicense = license(
      "license-old-001",
      "install-old-001",
      exportInstallationPublicKey(oldKeys.publicKey),
    );
    const newLicense = license(
      "license-new-001",
      "install-new-001",
      exportInstallationPublicKey(newKeys.publicKey),
    );

    const oldGrant = createCustomerProductGrantLifecycle(
      issueSelfManagedGrant(oldLicense, {
        grantId: "grant-old-001",
        issuedAt: NOW - 1_000,
        expiresAt: NOW + 500_000,
        allowedBotModes: ["AUTO"],
      }),
    );
    const newGrant = createCustomerProductGrantLifecycle(
      issueSelfManagedGrant(newLicense, {
        grantId: "grant-new-001",
        issuedAt: NOW,
        expiresAt: NOW + 500_000,
        allowedBotModes: ["AUTO"],
      }),
    );

    const store = new SqliteCustomerSecurityStore(path);
    await store.licenses.put(oldLicense);
    expect(
      await store.grants.compareAndSet(oldGrant.grant.grantId, null, oldGrant),
    ).toBe(true);

    const oldChallenge = createInstallationChallenge({
      purpose: "RECONNECT",
      licenseId: oldLicense.licenseId,
      installationId: oldLicense.installationId,
      now: NOW - 100,
      ttlMs: 60_000,
    });
    expect(await store.challenges.put(oldChallenge)).toBe(true);

    const decision = await store.migrateInstallation({
      oldGrantId: oldGrant.grant.grantId,
      newLicense,
      newGrant,
      migratedAt: NOW,
      authorizedBy: "customer-admin-service",
    });

    expect(decision).toMatchObject({
      ok: true,
      code: "MIGRATED",
      invalidatedChallenges: 1,
      audit: {
        customerId: oldLicense.customerId,
        oldInstallationId: oldLicense.installationId,
        newInstallationId: newLicense.installationId,
        authorizedBy: "customer-admin-service",
      },
    });

    await expect(store.licenses.get(oldLicense.licenseId)).resolves.toMatchObject({
      status: "REVOKED",
      revokedAt: NOW,
    });
    await expect(store.grants.get(oldGrant.grant.grantId)).resolves.toMatchObject({
      status: "REVOKED",
      revokedAt: NOW,
      revision: 2,
    });
    await expect(store.licenses.get(newLicense.licenseId)).resolves.toEqual(
      newLicense,
    );
    await expect(store.grants.get(newGrant.grant.grantId)).resolves.toEqual(
      newGrant,
    );
    await expect(
      store.challenges.consume(oldChallenge.challengeId, NOW + 1),
    ).resolves.toBe(false);

    const audit = await store.listInstallationMigrationAudit(
      oldLicense.customerId,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      eventType: "INSTALLATION_MIGRATED",
      oldLicenseId: oldLicense.licenseId,
      newLicenseId: newLicense.licenseId,
    });
    store.close();

    const reopened = new SqliteCustomerSecurityStore(path);
    await expect(
      reopened.licenses.get(oldLicense.licenseId),
    ).resolves.toMatchObject({ status: "REVOKED" });
    await expect(
      reopened.licenses.get(newLicense.licenseId),
    ).resolves.toEqual(newLicense);
    await expect(
      reopened.listInstallationMigrationAudit(oldLicense.customerId),
    ).resolves.toHaveLength(1);
    reopened.close();
  });

  it("rejects target conflicts without mutating the source binding", async () => {
    const path = databasePath();
    const oldKeys = generateInstallationDeviceKeyPair();
    const newKeys = generateInstallationDeviceKeyPair();
    const oldLicense = license(
      "license-old-conflict",
      "install-old-conflict",
      exportInstallationPublicKey(oldKeys.publicKey),
    );
    const newLicense = license(
      "license-new-conflict",
      "install-new-conflict",
      exportInstallationPublicKey(newKeys.publicKey),
    );
    const oldGrant = createCustomerProductGrantLifecycle(
      issueSelfManagedGrant(oldLicense, {
        grantId: "grant-old-conflict",
        issuedAt: NOW - 1_000,
        expiresAt: NOW + 500_000,
        allowedBotModes: ["AUTO"],
      }),
    );
    const newGrant = createCustomerProductGrantLifecycle(
      issueSelfManagedGrant(newLicense, {
        grantId: "grant-new-conflict",
        issuedAt: NOW,
        expiresAt: NOW + 500_000,
        allowedBotModes: ["AUTO"],
      }),
    );

    const store = new SqliteCustomerSecurityStore(path);
    await store.licenses.put(oldLicense);
    await store.licenses.put(newLicense);
    expect(
      await store.grants.compareAndSet(oldGrant.grant.grantId, null, oldGrant),
    ).toBe(true);

    await expect(
      store.migrateInstallation({
        oldGrantId: oldGrant.grant.grantId,
        newLicense,
        newGrant,
        migratedAt: NOW,
        authorizedBy: "customer-admin-service",
      }),
    ).resolves.toEqual({ ok: false, code: "TARGET_CONFLICT" });

    await expect(store.licenses.get(oldLicense.licenseId)).resolves.toEqual(
      oldLicense,
    );
    await expect(store.grants.get(oldGrant.grant.grantId)).resolves.toEqual(
      oldGrant,
    );
    store.close();
  });
});
