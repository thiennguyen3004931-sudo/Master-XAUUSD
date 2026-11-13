import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCustomerProductGrantLifecycle,
  issueSelfManagedGrant,
  revokeCustomerProductGrant,
} from "@xauusd/customer-product-access";
import { createInstallationChallenge } from "@xauusd/installation-proof";
import type { LicenseRecord } from "@xauusd/license-service";
import { SqliteCustomerSecurityStore } from "./sqlite-store.js";

const NOW = 12_000_000;
const tempDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "xauusd-customer-security-"));
  tempDirectories.push(directory);
  return join(directory, "customer-security.sqlite");
}

function license(): LicenseRecord {
  return {
    licenseId: "license-durable-001",
    status: "ACTIVE",
    customerId: "customer-durable-001",
    allowedMt5Logins: [770001],
    allowedBrokerServers: ["Broker-Real"],
    installationId: "install-durable-001",
    installationPublicKey: "installation-public-key",
    plan: "CUSTOMER_V1",
    maxAccounts: 1,
    issuedAt: NOW - 10_000,
    expiresAt: NOW + 500_000,
    revokedAt: null,
  };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe("SqliteCustomerSecurityStore", () => {
  it("persists license and grant records across process-style reopen", async () => {
    const path = databasePath();
    const currentLicense = license();
    const lifecycle = createCustomerProductGrantLifecycle(
      issueSelfManagedGrant(currentLicense, {
        grantId: "grant-durable-001",
        issuedAt: NOW - 1_000,
        expiresAt: NOW + 120_000,
        allowedBotModes: ["AUTO"],
      }),
    );

    const first = new SqliteCustomerSecurityStore(path);
    await first.licenses.put(currentLicense);
    expect(
      await first.grants.compareAndSet(
        lifecycle.grant.grantId,
        null,
        lifecycle,
      ),
    ).toBe(true);
    first.close();

    const reopened = new SqliteCustomerSecurityStore(path);
    await expect(reopened.licenses.get(currentLicense.licenseId)).resolves.toEqual(
      currentLicense,
    );
    await expect(reopened.grants.get(lifecycle.grant.grantId)).resolves.toEqual(
      lifecycle,
    );
    reopened.close();
  });

  it("never resurrects a revoked license with a stale ACTIVE write, including after reopen", async () => {
    const path = databasePath();
    const active = license();
    const revoked: LicenseRecord = {
      ...active,
      status: "REVOKED",
      revokedAt: NOW + 1,
    };

    const first = new SqliteCustomerSecurityStore(path);
    await first.licenses.put(active);
    await first.licenses.put(revoked);
    await expect(first.licenses.put(active)).rejects.toThrow(
      "CUSTOMER_LICENSE_REVOKED_IMMUTABLE",
    );
    await expect(first.licenses.get(active.licenseId)).resolves.toEqual(revoked);
    // A repeated copy of the exact revoked record stays idempotent.
    await expect(first.licenses.put({ ...revoked })).resolves.toBeUndefined();
    first.close();

    const reopened = new SqliteCustomerSecurityStore(path);
    await expect(reopened.licenses.put(active)).rejects.toThrow(
      "CUSTOMER_LICENSE_REVOKED_IMMUTABLE",
    );
    await expect(reopened.licenses.put({
      ...revoked,
      allowedMt5Logins: [770002],
    })).rejects.toThrow("CUSTOMER_LICENSE_REVOKED_IMMUTABLE");
    await expect(reopened.licenses.get(active.licenseId)).resolves.toEqual(revoked);
    reopened.close();
  });

  it("witnesses physical pre-revocation backup rollback despite in-place immutability guard (P0 #176)", async () => {
    // Disposable, synthetic SQLite state ONLY. Demonstrate a known release
    // blocker: restoring an older *physical file* bypasses local write guards.
    // This test intentionally does NOT assert that old-backup restore is safe.
    const path = databasePath();
    const oldBackupPath = path.slice(0, -".sqlite".length) + "-pre-revocation.sqlite";
    const activeLicense = license();
    const activeGrant = createCustomerProductGrantLifecycle(
      issueSelfManagedGrant(activeLicense, {
        grantId: "grant-stale-backup-witness",
        issuedAt: NOW - 1_000,
        expiresAt: NOW + 120_000,
        allowedBotModes: ["AUTO"],
      }),
    );

    const initial = new SqliteCustomerSecurityStore(path);
    await initial.licenses.put(activeLicense);
    expect(await initial.grants.compareAndSet(
      activeGrant.grant.grantId, null, activeGrant,
    )).toBe(true);
    initial.close();

    // Copy a CLOSED database; avoid confusing WAL snapshots or copying live
    // customer security files. This is NOT an approved backup procedure.
    copyFileSync(path, oldBackupPath);

    const later = new SqliteCustomerSecurityStore(path);
    const revokedLicense: LicenseRecord = {
      ...activeLicense, status: "REVOKED", revokedAt: NOW + 1,
    };
    const revokedGrant = revokeCustomerProductGrant(activeGrant, NOW + 1);
    await later.licenses.put(revokedLicense);
    expect(await later.grants.compareAndSet(
      activeGrant.grant.grantId, activeGrant.revision, revokedGrant,
    )).toBe(true);
    await expect(later.licenses.put(activeLicense)).rejects.toThrow(
      "CUSTOMER_LICENSE_REVOKED_IMMUTABLE",
    );
    later.close();

    // A standalone old SQLite file can still contain ACTIVE access. That
    // proves that a DB-local immutability rule is NOT a restore anti-rollback
    // defense. No gateway or customer agent is constructed in this test.
    const restoredOldBackup = new SqliteCustomerSecurityStore(oldBackupPath);
    const staleLicense = await restoredOldBackup.licenses.get(activeLicense.licenseId);
    const staleGrant = await restoredOldBackup.grants.get(activeGrant.grant.grantId);
    expect(staleLicense).toEqual(activeLicense);
    expect(staleGrant).toEqual(activeGrant);
    restoredOldBackup.close();

    // The trusted baseline must be held independently of any restored DB.
    // The baseline values here are only synthetic test-memory witnesses,
    // NOT an authenticated/production revocation authority.
    const independentBaseline = Object.freeze({
      licenseStatus: "REVOKED",
      grantStatus: "REVOKED",
      revokedAt: NOW + 1,
    });
    // Check the values ACTUALLY fetched from the restored snapshot, not
    // merely the test's original fixture variables.
    expect(staleLicense?.status).toBe("ACTIVE");
    expect(staleGrant?.status).toBe("ACTIVE");
    expect(staleLicense?.status).not.toBe(independentBaseline.licenseStatus);
    expect(staleGrant?.status).not.toBe(independentBaseline.grantStatus);
    expect(revokedLicense.revokedAt).toBe(independentBaseline.revokedAt);
    expect(revokedGrant.revokedAt).toBe(independentBaseline.revokedAt);

    const accepted = new SqliteCustomerSecurityStore(path);
    await expect(accepted.licenses.get(activeLicense.licenseId))
      .resolves.toEqual(revokedLicense);
    await expect(accepted.grants.get(activeGrant.grant.grantId))
      .resolves.toEqual(revokedGrant);
    accepted.close();
  });

  it("preserves grant compare-and-set revision semantics", async () => {
    const path = databasePath();
    const currentLicense = license();
    const lifecycle = createCustomerProductGrantLifecycle(
      issueSelfManagedGrant(currentLicense, {
        grantId: "grant-cas-001",
        issuedAt: NOW - 1_000,
        expiresAt: NOW + 120_000,
        allowedBotModes: ["AUTO"],
      }),
    );
    const revoked = revokeCustomerProductGrant(lifecycle, NOW + 1);

    const store = new SqliteCustomerSecurityStore(path);
    expect(
      await store.grants.compareAndSet(lifecycle.grant.grantId, null, lifecycle),
    ).toBe(true);
    expect(
      await store.grants.compareAndSet(
        lifecycle.grant.grantId,
        lifecycle.revision + 10,
        revoked,
      ),
    ).toBe(false);
    expect(
      await store.grants.compareAndSet(
        lifecycle.grant.grantId,
        lifecycle.revision,
        revoked,
      ),
    ).toBe(true);
    await expect(store.grants.get(lifecycle.grant.grantId)).resolves.toEqual(
      revoked,
    );
    store.close();
  });

  it("never reactivates or changes a revoked grant through a stale CAS, even after reopen", async () => {
    const path = databasePath();
    const currentLicense = license();
    const active = createCustomerProductGrantLifecycle(
      issueSelfManagedGrant(currentLicense, {
        grantId: "grant-revoked-immutable-001",
        issuedAt: NOW - 1_000,
        expiresAt: NOW + 120_000,
        allowedBotModes: ["AUTO"],
      }),
    );
    const revoked = revokeCustomerProductGrant(active, NOW + 1);
    const changedRevocation = { ...revoked, revokedAt: NOW + 2 };

    const first = new SqliteCustomerSecurityStore(path);
    expect(await first.grants.compareAndSet(active.grant.grantId, null, active)).toBe(true);
    expect(await first.grants.compareAndSet(active.grant.grantId, active.revision, revoked)).toBe(true);

    // The previous implementation accepted this downgrade when the caller
    // supplied the current revision: revision alone is not an authorization.
    expect(await first.grants.compareAndSet(active.grant.grantId, revoked.revision, active)).toBe(false);
    expect(await first.grants.compareAndSet(active.grant.grantId, revoked.revision, changedRevocation)).toBe(false);
    expect(await first.grants.compareAndSet(active.grant.grantId, null, active)).toBe(false);
    expect(await first.grants.compareAndSet(active.grant.grantId, revoked.revision, revoked)).toBe(true);
    await expect(first.grants.get(active.grant.grantId)).resolves.toEqual(revoked);
    first.close();

    const reopened = new SqliteCustomerSecurityStore(path);
    expect(await reopened.grants.compareAndSet(active.grant.grantId, revoked.revision, active)).toBe(false);
    expect(await reopened.grants.compareAndSet(active.grant.grantId, revoked.revision, changedRevocation)).toBe(false);
    await expect(reopened.grants.get(active.grant.grantId)).resolves.toEqual(revoked);
    reopened.close();
  });

  it("persists one-time challenge consumption across reopen", async () => {
    const path = databasePath();
    const challenge = createInstallationChallenge({
      purpose: "RECONNECT",
      licenseId: "license-durable-001",
      installationId: "install-durable-001",
      now: NOW,
      ttlMs: 60_000,
    });

    const first = new SqliteCustomerSecurityStore(path);
    await expect(first.challenges.put(challenge)).resolves.toBe(true);
    first.close();

    const reopened = new SqliteCustomerSecurityStore(path);
    await expect(reopened.challenges.put(challenge)).resolves.toBe(false);
    await expect(
      reopened.challenges.consume(challenge.challengeId, NOW + 1_000),
    ).resolves.toBe(true);
    reopened.close();

    const third = new SqliteCustomerSecurityStore(path);
    await expect(
      third.challenges.consume(challenge.challengeId, NOW + 2_000),
    ).resolves.toBe(false);
    third.close();
  });

  it("fails closed when consuming an expired or not-yet-valid challenge", async () => {
    const path = databasePath();
    const challenge = createInstallationChallenge({
      purpose: "RECONNECT",
      licenseId: "license-durable-001",
      installationId: "install-durable-001",
      now: NOW,
      ttlMs: 60_000,
    });

    const store = new SqliteCustomerSecurityStore(path);
    await expect(store.challenges.put(challenge)).resolves.toBe(true);
    await expect(
      store.challenges.consume(challenge.challengeId, NOW - 1),
    ).resolves.toBe(false);
    await expect(
      store.challenges.consume(challenge.challengeId, challenge.expiresAt + 1),
    ).resolves.toBe(false);
    store.close();
  });
});
