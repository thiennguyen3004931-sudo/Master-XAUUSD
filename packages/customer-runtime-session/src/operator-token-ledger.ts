/**
 * Operator-side reference store for bearer token lifecycle.
 * Never put this database, its WAL/SHM, or its backups under the customer's
 * restorable security database or install directory. NOT a complete P0 fix.
 *
 * Provisioning and use require independently audited OS ACL, encrypted backup,
 * non-restorable monotonic authority, and a separately authorized operator.
 */
import { closeSync, lstatSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncInstance } from "node:sqlite";
import type {
  CustomerApiTokenLifecycleLedger,
  CustomerApiTokenLifecycleRecord,
} from "./api-token-lifecycle.js";

function openDatabaseSync(path: string): DatabaseSyncInstance {
  const { DatabaseSync } = createRequire(process.cwd() + "/package.json")("node:sqlite") as {
    DatabaseSync: new (path: string) => DatabaseSyncInstance;
  };
  return new DatabaseSync(path);
}
const safe = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const identity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value && value.length <= 256;

function assertStoreLocation(path: string): void {
  if (typeof path !== "string" || !path || path === ":memory:") throw new TypeError("OPERATOR_LEDGER_PATH_INVALID");
  try {
    const dir = lstatSync(dirname(path));
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("OPERATOR_LEDGER_DIRECTORY_INVALID");
  } catch {
    throw new Error("OPERATOR_LEDGER_DIRECTORY_INVALID");
  }
}
function assertExistingFile(path: string): void {
  assertStoreLocation(path);
  try {
    const state = lstatSync(path);
    if (!state.isFile() || state.isSymbolicLink()) throw new Error("OPERATOR_LEDGER_FILE_INVALID");
  } catch {
    throw new Error("OPERATOR_LEDGER_FILE_INVALID");
  }
}

/**
 * Explicit EMPTY store setup only, never called during Gateway startup.
 * Caller must ensure the directory is operator-owned, outside customer backups,
 * with separately approved credential, filesystem ACL and disaster recovery.
 */
export function initializeEmptyOperatorTokenLedger(path: string): void {
  assertStoreLocation(path);
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch {
    throw new Error("OPERATOR_LEDGER_INITIALIZATION_DENIED");
  }
  closeSync(fd);
  let db: DatabaseSyncInstance | null = null;
  try {
    db = openDatabaseSync(path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE token_ledger_schema (name TEXT PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO token_ledger_schema (name, version) VALUES ('token_lifecycle', 1);
      CREATE TABLE operator_token_records (
        token_sha256_hex TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE','REVOKED')),
        not_before_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER,
        generation INTEGER NOT NULL CHECK(generation >= 1)
      );
    `);
  } catch {
    throw new Error("OPERATOR_LEDGER_INITIALIZATION_FAILED");
  } finally {
    db?.close();
  }
}

export class OperatorSqliteCustomerTokenLedger implements CustomerApiTokenLifecycleLedger {
  private readonly db: DatabaseSyncInstance;

  constructor(path: string) {
    assertExistingFile(path);
    let db: DatabaseSyncInstance | null = null;
    try {
      db = openDatabaseSync(path);
      const row = db.prepare("SELECT version FROM token_ledger_schema WHERE name = 'token_lifecycle'").get() as
        | { version: unknown } | undefined;
      if (!row || row.version !== 1) throw new Error("OPERATOR_LEDGER_SCHEMA_INVALID");
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    } catch {
      db?.close();
      throw new Error("OPERATOR_LEDGER_OPEN_FAILED");
    }
    if (!db) throw new Error("OPERATOR_LEDGER_OPEN_FAILED");
    this.db = db;
  }

  async getBySha256(sha256Hex: string): Promise<CustomerApiTokenLifecycleRecord | null> {
    if (!digest(sha256Hex)) return null;
    try {
      const row = this.db.prepare(`
        SELECT token_sha256_hex, customer_id, status, not_before_ms,
               expires_at_ms, revoked_at_ms, generation
        FROM operator_token_records WHERE token_sha256_hex = ?
      `).get(sha256Hex) as Record<string, unknown> | undefined;
      if (!row) return null;
      if (!digest(row.token_sha256_hex) || !identity(row.customer_id) ||
          (row.status !== "ACTIVE" && row.status !== "REVOKED") ||
          !safe(row.not_before_ms) || !safe(row.expires_at_ms) || !safe(row.generation) ||
          !Number.isSafeInteger(row.generation) || (row.generation as number) < 1 ||
          (row.revoked_at_ms !== null && !safe(row.revoked_at_ms))) {
        throw new Error("OPERATOR_LEDGER_STATE_INVALID");
      }
      return Object.freeze({
        tokenSha256Hex: row.token_sha256_hex,
        customerId: row.customer_id,
        status: row.status,
        notBeforeMs: row.not_before_ms,
        expiresAtMs: row.expires_at_ms,
        revokedAtMs: row.revoked_at_ms,
        generation: row.generation,
      }) as CustomerApiTokenLifecycleRecord;
    } catch {
      throw new Error("OPERATOR_LEDGER_READ_UNAVAILABLE");
    }
  }

  /** Creates a NEW token identity only; never resets an existing hash or revocation. */
  async registerToken(record: CustomerApiTokenLifecycleRecord): Promise<boolean> {
    if (!record || !digest(record.tokenSha256Hex) || !identity(record.customerId) ||
        record.status !== "ACTIVE" || record.generation !== 1 || record.revokedAtMs !== null ||
        !safe(record.notBeforeMs) || !safe(record.expiresAtMs) ||
        record.expiresAtMs <= record.notBeforeMs) return false;
    try {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO operator_token_records
          (token_sha256_hex, customer_id, status, not_before_ms, expires_at_ms, revoked_at_ms, generation)
        VALUES (?, ?, 'ACTIVE', ?, ?, NULL, 1)
      `).run(record.tokenSha256Hex, record.customerId, record.notBeforeMs, record.expiresAtMs);
      return Number(result.changes) === 1;
    } catch {
      throw new Error("OPERATOR_LEDGER_WRITE_UNAVAILABLE");
    }
  }

  /**
   * Exact-generation CAS; a revoked digest remains permanently revoked here.
   * Reissue/rotation MUST use a separately generated new token digest.
   */
  async revokeToken(sha256Hex: string, expectedGeneration: number, revokedAtMs: number): Promise<boolean> {
    if (!digest(sha256Hex) || !safe(expectedGeneration) || expectedGeneration < 1 ||
        expectedGeneration >= Number.MAX_SAFE_INTEGER || !safe(revokedAtMs)) return false;
    try {
      const result = this.db.prepare(`
        UPDATE operator_token_records
        SET status = 'REVOKED', revoked_at_ms = ?, generation = generation + 1
        WHERE token_sha256_hex = ? AND status = 'ACTIVE' AND generation = ?
      `).run(revokedAtMs, sha256Hex, expectedGeneration);
      return Number(result.changes) === 1;
    } catch {
      throw new Error("OPERATOR_LEDGER_WRITE_UNAVAILABLE");
    }
  }

  /**
   * Operator-provisioned bounded overlap rotation. The new digest is inserted
   * and the old expiry is shortened (or immediately revoked) in ONE transaction.
   * No live administrative service, audit authorization, or plaintext tokens.
   */
  async rotateToken(
    oldSha256Hex: string,
    next: CustomerApiTokenLifecycleRecord,
    expectedGeneration: number,
    rotatedAtMs: number,
    overlapMs: number,
  ): Promise<boolean> {
    if (!digest(oldSha256Hex) || !next || !digest(next.tokenSha256Hex) ||
        oldSha256Hex === next.tokenSha256Hex || !identity(next.customerId) ||
        next.status !== "ACTIVE" || next.revokedAtMs !== null || next.generation !== 1 ||
        !safe(next.notBeforeMs) || !safe(next.expiresAtMs) || next.expiresAtMs <= next.notBeforeMs ||
        !safe(expectedGeneration) || expectedGeneration < 1 ||
        expectedGeneration >= Number.MAX_SAFE_INTEGER ||
        !safe(rotatedAtMs) || !safe(overlapMs) || overlapMs > 60_000 ||
        !safe(rotatedAtMs + overlapMs) ||
        next.notBeforeMs > rotatedAtMs || next.expiresAtMs <= rotatedAtMs) return false;
    let began = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      began = true;
      const old = this.db.prepare(`
        SELECT customer_id, status, not_before_ms, expires_at_ms, generation
        FROM operator_token_records WHERE token_sha256_hex = ?
      `).get(oldSha256Hex) as Record<string, unknown> | undefined;
      if (!old || old.customer_id !== next.customerId || old.status !== "ACTIVE" ||
          old.generation !== expectedGeneration || !safe(old.not_before_ms) ||
          !safe(old.expires_at_ms) || rotatedAtMs < old.not_before_ms ||
          rotatedAtMs >= old.expires_at_ms) {
        this.db.exec("ROLLBACK");
        began = false;
        return false;
      }
      const newToken = this.db.prepare(`
        INSERT OR IGNORE INTO operator_token_records
          (token_sha256_hex, customer_id, status, not_before_ms, expires_at_ms, revoked_at_ms, generation)
        VALUES (?, ?, 'ACTIVE', ?, ?, NULL, 1)
      `).run(next.tokenSha256Hex, next.customerId, next.notBeforeMs, next.expiresAtMs);
      if (Number(newToken.changes) !== 1) {
        this.db.exec("ROLLBACK");
        began = false;
        return false;
      }
      const oldExpiry = Math.min(old.expires_at_ms, rotatedAtMs + overlapMs);
      const noOverlap = oldExpiry <= rotatedAtMs;
      const update = noOverlap
        ? this.db.prepare(`
            UPDATE operator_token_records SET status='REVOKED', revoked_at_ms=?,
              generation=generation+1 WHERE token_sha256_hex=? AND status='ACTIVE' AND generation=?
          `).run(rotatedAtMs, oldSha256Hex, expectedGeneration)
        : this.db.prepare(`
            UPDATE operator_token_records SET expires_at_ms=?, generation=generation+1
            WHERE token_sha256_hex=? AND status='ACTIVE' AND generation=?
          `).run(oldExpiry, oldSha256Hex, expectedGeneration);
      if (Number(update.changes) !== 1) {
        this.db.exec("ROLLBACK");
        began = false;
        return false;
      }
      this.db.exec("COMMIT");
      began = false;
      return true;
    } catch {
      if (began) {
        try { this.db.exec("ROLLBACK"); } catch { /* uncertain => never report success */ }
      }
      throw new Error("OPERATOR_LEDGER_ROTATION_UNAVAILABLE");
    }
  }

  close(): void {
    this.db.close();
  }
}
