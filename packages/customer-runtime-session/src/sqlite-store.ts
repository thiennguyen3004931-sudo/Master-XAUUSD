import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncInstance } from "node:sqlite";
import type { CustomerGrantRegistryRepository } from "@xauusd/customer-grant-registry";
import {
  assertCustomerProductGrantLifecycleRecord,
  revokeCustomerProductGrant,
  type CustomerProductGrantLifecycleRecord,
} from "@xauusd/customer-product-access";
import {
  assertInstallationChallenge,
  type InstallationChallenge,
} from "@xauusd/installation-proof";
import {
  assertLicenseRecord,
  type LicenseRecord,
} from "@xauusd/license-service";
import type { CustomerLicenseResolver } from "@xauusd/customer-runtime-gate";
import type { CustomerRuntimeChallengeStore } from "./session.js";

function openDatabaseSync(path: string): DatabaseSyncInstance {
  const { DatabaseSync } = createRequire(process.cwd() + "/package.json")("node:sqlite") as {
    DatabaseSync: new (path: string) => DatabaseSyncInstance;
  };
  return new DatabaseSync(path);
}

type SqlRow = Record<string, unknown>;

function canonicalNonBlank(value: string, field: string): void {
  if (value.length === 0 || value.trim().length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be a canonical non-blank string`);
  }
}

function safeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
}

function cloneLicense(record: LicenseRecord): LicenseRecord {
  assertLicenseRecord(record);
  return Object.freeze({
    ...record,
    allowedMt5Logins: Object.freeze([...record.allowedMt5Logins]),
    allowedBrokerServers: Object.freeze([...record.allowedBrokerServers]),
  });
}

function cloneGrant(
  record: CustomerProductGrantLifecycleRecord,
): CustomerProductGrantLifecycleRecord {
  assertCustomerProductGrantLifecycleRecord(record);
  return Object.freeze({
    version: 1,
    grant: Object.freeze({
      ...record.grant,
      allowedBotModes: Object.freeze([...record.grant.allowedBotModes]),
      allowedCopySizingModes: Object.freeze([
        ...record.grant.allowedCopySizingModes,
      ]),
    }),
    status: record.status,
    revokedAt: record.revokedAt,
    revision: record.revision,
  });
}

function parseLicense(payload: unknown): LicenseRecord {
  if (typeof payload !== "string") {
    throw new TypeError("persisted license payload must be text");
  }
  const parsed: unknown = JSON.parse(payload);
  assertLicenseRecord(parsed);
  return cloneLicense(parsed);
}

function parseGrant(payload: unknown): CustomerProductGrantLifecycleRecord {
  if (typeof payload !== "string") {
    throw new TypeError("persisted grant payload must be text");
  }
  const parsed: unknown = JSON.parse(payload);
  assertCustomerProductGrantLifecycleRecord(parsed);
  return cloneGrant(parsed);
}

function parseChallenge(payload: unknown): InstallationChallenge {
  if (typeof payload !== "string") {
    throw new TypeError("persisted challenge payload must be text");
  }
  const parsed: unknown = JSON.parse(payload);
  assertInstallationChallenge(parsed);
  return Object.freeze({ ...parsed });
}

function invalidateChallengesForInstallation(
  db: DatabaseSyncInstance,
  installationId: string,
  now: number,
): number {
  canonicalNonBlank(installationId, "installationId");
  safeInteger(now, "now");

  const rows = db
    .prepare(
      "SELECT challenge_id, payload_json FROM customer_runtime_challenges WHERE consumed_at IS NULL",
    )
    .all() as SqlRow[];

  let invalidated = 0;
  const update = db.prepare(
    "UPDATE customer_runtime_challenges SET consumed_at = ? WHERE challenge_id = ? AND consumed_at IS NULL",
  );

  for (const row of rows) {
    const challenge = parseChallenge(row.payload_json);
    if (challenge.installationId !== installationId) continue;
    const result = update.run(now, challenge.challengeId);
    invalidated += Number(result.changes);
  }

  return invalidated;
}

function initializeSchema(db: DatabaseSyncInstance): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS customer_security_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO customer_security_meta(key, value)
    VALUES ('schema_version', '1');

    CREATE TABLE IF NOT EXISTS customer_license_records (
      license_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customer_grant_records (
      grant_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customer_runtime_challenges (
      challenge_id TEXT PRIMARY KEY,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customer_security_audit (
      audit_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      old_license_id TEXT NOT NULL,
      new_license_id TEXT NOT NULL,
      old_grant_id TEXT NOT NULL,
      new_grant_id TEXT NOT NULL,
      old_installation_id TEXT NOT NULL,
      new_installation_id TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      authorized_by TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_customer_runtime_challenges_expiry
      ON customer_runtime_challenges(expires_at);

    CREATE INDEX IF NOT EXISTS idx_customer_security_audit_customer
      ON customer_security_audit(customer_id, occurred_at);
  `);
}

export class SqliteCustomerLicenseRepository
  implements CustomerLicenseResolver
{
  constructor(private readonly db: DatabaseSyncInstance) {}

  async get(licenseId: string): Promise<LicenseRecord | null> {
    canonicalNonBlank(licenseId, "licenseId");
    const row = this.db
      .prepare(
        "SELECT payload_json FROM customer_license_records WHERE license_id = ?",
      )
      .get(licenseId) as SqlRow | undefined;

    return row ? parseLicense(row.payload_json) : null;
  }

  async put(record: LicenseRecord): Promise<void> {
    assertLicenseRecord(record);

    // Keep an already revoked license immutable inside the live SQLite
    // database. BEGIN IMMEDIATE serializes this check with concurrent writers
    // so an older ACTIVE record cannot silently undo a committed revocation.
    // This does NOT protect against restoring an older physical database
    // backup; that needs an external trusted anti-rollback authority (#176).
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const currentRow = this.db
        .prepare(
          "SELECT payload_json FROM customer_license_records WHERE license_id = ?",
        )
        .get(record.licenseId) as SqlRow | undefined;

      if (currentRow) {
        const current = parseLicense(currentRow.payload_json);
        if (
          current.status === "REVOKED" &&
          JSON.stringify(current) !== JSON.stringify(record)
        ) {
          throw new Error("CUSTOMER_LICENSE_REVOKED_IMMUTABLE");
        }
      }

      this.db
        .prepare(`
          INSERT INTO customer_license_records(license_id, payload_json)
          VALUES (?, ?)
          ON CONFLICT(license_id) DO UPDATE SET
            payload_json = excluded.payload_json
        `)
        .run(record.licenseId, JSON.stringify(record));
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // If SQLite already aborted the transaction, preserve original error.
      }
      throw error;
    }
  }
}

export class SqliteCustomerGrantRegistryRepository
  implements CustomerGrantRegistryRepository
{
  constructor(private readonly db: DatabaseSyncInstance) {}

  async get(
    grantId: string,
  ): Promise<CustomerProductGrantLifecycleRecord | null> {
    canonicalNonBlank(grantId, "grantId");
    const row = this.db
      .prepare(
        "SELECT payload_json FROM customer_grant_records WHERE grant_id = ?",
      )
      .get(grantId) as SqlRow | undefined;

    return row ? parseGrant(row.payload_json) : null;
  }

  async compareAndSet(
    grantId: string,
    expectedRevision: number | null,
    next: CustomerProductGrantLifecycleRecord,
  ): Promise<boolean> {
    canonicalNonBlank(grantId, "grantId");
    assertCustomerProductGrantLifecycleRecord(next);

    if (next.grant.grantId !== grantId) {
      throw new TypeError("repository grantId must match lifecycle grantId");
    }

    if (
      expectedRevision !== null &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0)
    ) {
      throw new TypeError(
        "expectedRevision must be null or a positive safe integer",
      );
    }

    const payload = JSON.stringify(next);

    if (expectedRevision === null) {
      const result = this.db
        .prepare(`
          INSERT OR IGNORE INTO customer_grant_records(
            grant_id,
            revision,
            payload_json
          ) VALUES (?, ?, ?)
        `)
        .run(grantId, next.revision, payload);
      return result.changes === 1;
    }

    // A revoked grant must never be restored to ACTIVE (or modified) by a
    // stale writer. Serialize the state check with the revision CAS.
    // Physical backup rollback remains a separate P0 gate (#176).
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const currentRow = this.db
        .prepare(
          "SELECT payload_json FROM customer_grant_records WHERE grant_id = ? AND revision = ?",
        )
        .get(grantId, expectedRevision) as SqlRow | undefined;
      if (!currentRow) {
        this.db.exec("ROLLBACK");
        return false;
      }

      const current = parseGrant(currentRow.payload_json);
      if (
        current.status === "REVOKED" &&
        JSON.stringify(current) !== payload
      ) {
        this.db.exec("ROLLBACK");
        return false;
      }

      const result = this.db
        .prepare(`
          UPDATE customer_grant_records
          SET revision = ?, payload_json = ?
          WHERE grant_id = ? AND revision = ?
        `)
        .run(next.revision, payload, grantId, expectedRevision);
      this.db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original SQLite or validation failure.
      }
      throw error;
    }
  }

  async list(): Promise<readonly CustomerProductGrantLifecycleRecord[]> {
    const rows = this.db
      .prepare(
        "SELECT payload_json FROM customer_grant_records ORDER BY grant_id ASC",
      )
      .all() as SqlRow[];

    return Object.freeze(rows.map((row) => parseGrant(row.payload_json)));
  }
}

export class SqliteCustomerRuntimeChallengeStore
  implements CustomerRuntimeChallengeStore
{
  constructor(private readonly db: DatabaseSyncInstance) {}

  async put(challenge: InstallationChallenge): Promise<boolean> {
    assertInstallationChallenge(challenge);

    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO customer_runtime_challenges(
          challenge_id,
          issued_at,
          expires_at,
          consumed_at,
          payload_json
        ) VALUES (?, ?, ?, NULL, ?)
      `)
      .run(
        challenge.challengeId,
        challenge.issuedAt,
        challenge.expiresAt,
        JSON.stringify(challenge),
      );

    return result.changes === 1;
  }

  async consume(challengeId: string, now: number): Promise<boolean> {
    canonicalNonBlank(challengeId, "challengeId");
    safeInteger(now, "now");

    const result = this.db
      .prepare(`
        UPDATE customer_runtime_challenges
        SET consumed_at = ?
        WHERE challenge_id = ?
          AND consumed_at IS NULL
          AND ? >= issued_at
          AND ? <= expires_at
      `)
      .run(now, challengeId, now, now);

    return result.changes === 1;
  }

  async invalidateInstallation(
    installationId: string,
    now: number,
  ): Promise<number> {
    return invalidateChallengesForInstallation(this.db, installationId, now);
  }
}

export interface CustomerInstallationMigrationRequest {
  readonly oldGrantId: string;
  readonly newLicense: LicenseRecord;
  readonly newGrant: CustomerProductGrantLifecycleRecord;
  readonly migratedAt: number;
  readonly authorizedBy: string;
}

export interface CustomerInstallationMigrationAuditEvent {
  readonly auditId: string;
  readonly eventType: "INSTALLATION_MIGRATED";
  readonly customerId: string;
  readonly oldLicenseId: string;
  readonly newLicenseId: string;
  readonly oldGrantId: string;
  readonly newGrantId: string;
  readonly oldInstallationId: string;
  readonly newInstallationId: string;
  readonly occurredAt: number;
  readonly authorizedBy: string;
}

export type CustomerInstallationMigrationDecision =
  | {
      readonly ok: true;
      readonly code: "MIGRATED";
      readonly invalidatedChallenges: number;
      readonly audit: CustomerInstallationMigrationAuditEvent;
    }
  | {
      readonly ok: false;
      readonly code:
        | "INVALID_REQUEST"
        | "SOURCE_NOT_FOUND"
        | "SOURCE_ALREADY_REVOKED"
        | "TARGET_CONFLICT"
        | "BINDING_MISMATCH"
        | "REVISION_CONFLICT"
        | "PERSISTENCE_ERROR";
    };

export class SqliteCustomerSecurityStore {
  private readonly db: DatabaseSyncInstance;

  readonly licenses: SqliteCustomerLicenseRepository;
  readonly grants: SqliteCustomerGrantRegistryRepository;
  readonly challenges: SqliteCustomerRuntimeChallengeStore;

  constructor(databasePath: string) {
    canonicalNonBlank(databasePath, "databasePath");
    this.db = openDatabaseSync(databasePath);
    initializeSchema(this.db);
    this.licenses = new SqliteCustomerLicenseRepository(this.db);
    this.grants = new SqliteCustomerGrantRegistryRepository(this.db);
    this.challenges = new SqliteCustomerRuntimeChallengeStore(this.db);
  }

  async migrateInstallation(
    request: CustomerInstallationMigrationRequest,
  ): Promise<CustomerInstallationMigrationDecision> {
    try {
      canonicalNonBlank(request.oldGrantId, "oldGrantId");
      canonicalNonBlank(request.authorizedBy, "authorizedBy");
      safeInteger(request.migratedAt, "migratedAt");
      assertLicenseRecord(request.newLicense);
      assertCustomerProductGrantLifecycleRecord(request.newGrant);
    } catch {
      return { ok: false, code: "INVALID_REQUEST" };
    }

    const oldGrant = await this.grants.get(request.oldGrantId);
    if (!oldGrant) return { ok: false, code: "SOURCE_NOT_FOUND" };

    const oldLicense = await this.licenses.get(oldGrant.grant.licenseId);
    if (!oldLicense) return { ok: false, code: "SOURCE_NOT_FOUND" };

    if (
      oldGrant.status === "REVOKED" ||
      oldLicense.status === "REVOKED"
    ) {
      return { ok: false, code: "SOURCE_ALREADY_REVOKED" };
    }

    const newLicense = request.newLicense;
    const newGrant = request.newGrant;

    if (
      oldGrant.grant.customerId !== oldLicense.customerId ||
      oldGrant.grant.installationId !== oldLicense.installationId ||
      oldGrant.grant.licenseId !== oldLicense.licenseId ||
      newGrant.grant.customerId !== oldLicense.customerId ||
      newLicense.customerId !== oldLicense.customerId ||
      newGrant.grant.licenseId !== newLicense.licenseId ||
      newGrant.grant.installationId !== newLicense.installationId ||
      newGrant.grant.productMode !== oldGrant.grant.productMode ||
      newGrant.grant.issuedAt < newLicense.issuedAt ||
      newGrant.grant.expiresAt > newLicense.expiresAt ||
      newLicense.installationId === oldLicense.installationId ||
      newLicense.licenseId === oldLicense.licenseId ||
      newGrant.grant.grantId === oldGrant.grant.grantId ||
      newLicense.status !== "ACTIVE" ||
      newLicense.revokedAt !== null ||
      newGrant.status !== "ACTIVE" ||
      newGrant.revokedAt !== null ||
      newGrant.revision !== 1 ||
      request.migratedAt < oldLicense.issuedAt ||
      request.migratedAt < oldGrant.grant.issuedAt
    ) {
      return { ok: false, code: "BINDING_MISMATCH" };
    }

    if (
      (await this.licenses.get(newLicense.licenseId)) !== null ||
      (await this.grants.get(newGrant.grant.grantId)) !== null
    ) {
      return { ok: false, code: "TARGET_CONFLICT" };
    }

    let revokedGrant: CustomerProductGrantLifecycleRecord;
    let revokedLicense: LicenseRecord;
    try {
      revokedGrant = revokeCustomerProductGrant(
        oldGrant,
        request.migratedAt,
      );
      revokedLicense = Object.freeze({
        ...oldLicense,
        status: "REVOKED" as const,
        revokedAt: request.migratedAt,
      });
      assertLicenseRecord(revokedLicense);
    } catch {
      return { ok: false, code: "INVALID_REQUEST" };
    }

    const audit: CustomerInstallationMigrationAuditEvent = Object.freeze({
      auditId: randomUUID(),
      eventType: "INSTALLATION_MIGRATED",
      customerId: oldLicense.customerId,
      oldLicenseId: oldLicense.licenseId,
      newLicenseId: newLicense.licenseId,
      oldGrantId: oldGrant.grant.grantId,
      newGrantId: newGrant.grant.grantId,
      oldInstallationId: oldLicense.installationId,
      newInstallationId: newLicense.installationId,
      occurredAt: request.migratedAt,
      authorizedBy: request.authorizedBy,
    });

    try {
      this.db.exec("BEGIN IMMEDIATE");

      const currentGrantRow = this.db
        .prepare(
          "SELECT revision, payload_json FROM customer_grant_records WHERE grant_id = ?",
        )
        .get(oldGrant.grant.grantId) as SqlRow | undefined;
      const currentLicenseRow = this.db
        .prepare(
          "SELECT payload_json FROM customer_license_records WHERE license_id = ?",
        )
        .get(oldLicense.licenseId) as SqlRow | undefined;

      if (!currentGrantRow || !currentLicenseRow) {
        throw new Error("SOURCE_NOT_FOUND");
      }

      const currentGrant = parseGrant(currentGrantRow.payload_json);
      const currentLicense = parseLicense(currentLicenseRow.payload_json);
      if (
        currentGrant.revision !== oldGrant.revision ||
        currentGrant.status !== oldGrant.status ||
        currentLicense.status !== oldLicense.status ||
        currentLicense.installationId !== oldLicense.installationId
      ) {
        throw new Error("REVISION_CONFLICT");
      }

      const targetLicense = this.db
        .prepare(
          "SELECT 1 AS found FROM customer_license_records WHERE license_id = ?",
        )
        .get(newLicense.licenseId);
      const targetGrant = this.db
        .prepare(
          "SELECT 1 AS found FROM customer_grant_records WHERE grant_id = ?",
        )
        .get(newGrant.grant.grantId);
      if (targetLicense || targetGrant) {
        throw new Error("TARGET_CONFLICT");
      }

      const oldLicenseUpdate = this.db
        .prepare(
          "UPDATE customer_license_records SET payload_json = ? WHERE license_id = ?",
        )
        .run(JSON.stringify(revokedLicense), oldLicense.licenseId);
      const oldGrantUpdate = this.db
        .prepare(
          "UPDATE customer_grant_records SET revision = ?, payload_json = ? WHERE grant_id = ? AND revision = ?",
        )
        .run(
          revokedGrant.revision,
          JSON.stringify(revokedGrant),
          oldGrant.grant.grantId,
          oldGrant.revision,
        );

      if (
        oldLicenseUpdate.changes !== 1 ||
        oldGrantUpdate.changes !== 1
      ) {
        throw new Error("REVISION_CONFLICT");
      }

      this.db
        .prepare(
          "INSERT INTO customer_license_records(license_id, payload_json) VALUES (?, ?)",
        )
        .run(newLicense.licenseId, JSON.stringify(newLicense));
      this.db
        .prepare(
          "INSERT INTO customer_grant_records(grant_id, revision, payload_json) VALUES (?, ?, ?)",
        )
        .run(
          newGrant.grant.grantId,
          newGrant.revision,
          JSON.stringify(newGrant),
        );

      const invalidatedChallenges = invalidateChallengesForInstallation(
        this.db,
        oldLicense.installationId,
        request.migratedAt,
      );

      this.db
        .prepare(`
          INSERT INTO customer_security_audit(
            audit_id,
            event_type,
            customer_id,
            old_license_id,
            new_license_id,
            old_grant_id,
            new_grant_id,
            old_installation_id,
            new_installation_id,
            occurred_at,
            authorized_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          audit.auditId,
          audit.eventType,
          audit.customerId,
          audit.oldLicenseId,
          audit.newLicenseId,
          audit.oldGrantId,
          audit.newGrantId,
          audit.oldInstallationId,
          audit.newInstallationId,
          audit.occurredAt,
          audit.authorizedBy,
        );

      this.db.exec("COMMIT");
      return {
        ok: true,
        code: "MIGRATED",
        invalidatedChallenges,
        audit,
      };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Best-effort rollback after a failed transaction.
      }

      const message = error instanceof Error ? error.message : "";
      if (message === "REVISION_CONFLICT") {
        return { ok: false, code: "REVISION_CONFLICT" };
      }
      if (message === "TARGET_CONFLICT") {
        return { ok: false, code: "TARGET_CONFLICT" };
      }
      if (message === "SOURCE_NOT_FOUND") {
        return { ok: false, code: "SOURCE_NOT_FOUND" };
      }
      return { ok: false, code: "PERSISTENCE_ERROR" };
    }
  }

  async listInstallationMigrationAudit(
    customerId?: string,
  ): Promise<readonly CustomerInstallationMigrationAuditEvent[]> {
    if (customerId !== undefined) {
      canonicalNonBlank(customerId, "customerId");
    }

    const rows = customerId === undefined
      ? (this.db
          .prepare(
            "SELECT * FROM customer_security_audit WHERE event_type = 'INSTALLATION_MIGRATED' ORDER BY occurred_at ASC, audit_id ASC",
          )
          .all() as SqlRow[])
      : (this.db
          .prepare(
            "SELECT * FROM customer_security_audit WHERE event_type = 'INSTALLATION_MIGRATED' AND customer_id = ? ORDER BY occurred_at ASC, audit_id ASC",
          )
          .all(customerId) as SqlRow[]);

    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          auditId: String(row.audit_id),
          eventType: "INSTALLATION_MIGRATED" as const,
          customerId: String(row.customer_id),
          oldLicenseId: String(row.old_license_id),
          newLicenseId: String(row.new_license_id),
          oldGrantId: String(row.old_grant_id),
          newGrantId: String(row.new_grant_id),
          oldInstallationId: String(row.old_installation_id),
          newInstallationId: String(row.new_installation_id),
          occurredAt: Number(row.occurred_at),
          authorizedBy: String(row.authorized_by),
        }),
      ),
    );
  }

  close(): void {
    this.db.close();
  }
}
