/**
 * OFFLINE SYNTHETIC P0 #176 harness ONLY. Not safe for real customer data:
 * the SQLite backup API creates a temporary plaintext snapshot on disk.
 * Do not deploy this as a customer backup/restore procedure.
 *
 * Tests WAL-consistent SQLite online backup and AES-256-GCM archive integrity.
 * No CLI, no production path, no source mutations, no auto-restore.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { open, readFile, realpath, mkdtemp, rm, writeFile, lstat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const MARKER = "XAUUSD_SYNTHETIC_RESTORE_TEST_ONLY_V1\n";
const MAX_BYTES = 16 * 1024 * 1024;
const EXACT_FIELDS = ["schemaVersion", "algorithm", "nonce", "tag", "ciphertext", "plaintextSha256"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const strictBase64 = value => typeof value === "string" &&
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) &&
  Buffer.from(value, "base64").toString("base64") === value;

async function validateSandbox(root, filePath, mustExist) {
  const directory = await realpath(root);
  const tempRoot = await realpath(tmpdir());
  if (directory === tempRoot || !directory.startsWith(tempRoot + sep)) {
    throw new Error("SYNTHETIC_SANDBOX_REQUIRED");
  }
  if ((await readFile(join(directory, ".xau-synthetic-only"), "utf8")) !== MARKER) {
    throw new Error("SYNTHETIC_MARKER_REQUIRED");
  }
  const target = resolve(filePath);
  const parent = await realpath(dirname(target));
  if (parent !== directory && !parent.startsWith(directory + sep)) throw new Error("SYNTHETIC_PATH_OUTSIDE_SANDBOX");
  if (mustExist) {
    const final = await realpath(target);
    const details = await lstat(target);
    if (!final.startsWith(directory + sep) || !details.isFile() || details.isSymbolicLink()) {
      throw new Error("SYNTHETIC_SOURCE_INVALID");
    }
  }
  return { directory, target };
}

function checkKey(key) {
  if (!Buffer.isBuffer(key) || key.byteLength !== 32) throw new Error("SYNTHETIC_ENCRYPTION_KEY_INVALID");
}

function assertIntegrity(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("PRAGMA integrity_check").get();
    if (!row || Object.values(row)[0] !== "ok") throw new Error("SQLITE_INTEGRITY_FAILED");
  } finally {
    db.close();
  }
}

function parseArchive(data) {
  let envelope;
  try { envelope = JSON.parse(data); } catch { throw new Error("SNAPSHOT_ARCHIVE_INVALID"); }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
      Object.keys(envelope).sort().join("|") !== [...EXACT_FIELDS].sort().join("|") ||
      envelope.schemaVersion !== 1 || envelope.algorithm !== "AES-256-GCM" ||
      !strictBase64(envelope.nonce) || !strictBase64(envelope.tag) ||
      !strictBase64(envelope.ciphertext) ||
      !/^[0-9a-f]{64}$/.test(envelope.plaintextSha256)) {
    throw new Error("SNAPSHOT_ARCHIVE_INVALID");
  }
  const nonce = Buffer.from(envelope.nonce, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_BYTES + 32) {
    throw new Error("SNAPSHOT_ARCHIVE_INVALID");
  }
  return { ...envelope, nonce, tag, ciphertext };
}

/**
 * Creates a single AES-GCM archive from a WAL-aware SQLite backup.
 * Test-only sandbox marker is mandatory; archive file must not exist.
 */
export async function createSyntheticEncryptedSqliteSnapshot({ testRoot, sourcePath, archivePath, encryptionKey }) {
  checkKey(encryptionKey);
  const root = await validateSandbox(testRoot, sourcePath, true);
  await validateSandbox(testRoot, archivePath, false);
  if (resolve(sourcePath) === resolve(archivePath)) throw new Error("SYNTHETIC_PATH_COLLISION");
  const scratch = await mkdtemp(join(root.directory, "snapshot-test-"));
  let wrote = false;
  try {
    const snapshot = join(scratch, "snapshot.sqlite");
    const sourceDb = new DatabaseSync(root.target, { readOnly: true });
    try { await backup(sourceDb, snapshot); }
    finally { sourceDb.close(); }
    assertIntegrity(snapshot);
    const plaintext = await readFile(snapshot);
    if (plaintext.length === 0 || plaintext.length > MAX_BYTES) throw new Error("SYNTHETIC_SNAPSHOT_TOO_LARGE");
    const nonce = randomBytes(12);
    const plaintextSha256 = sha(plaintext);
    const header = { schemaVersion: 1, algorithm: "AES-256-GCM", plaintextSha256 };
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify(header)));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const payload = {
      ...header, nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const handle = await open(archivePath, "wx", 0o600);
    wrote = true;
    try {
      await handle.writeFile(JSON.stringify(payload) + "\n");
      await handle.sync();
    } finally { await handle.close(); }
    return Object.freeze({ ok: true, sourceSnapshotSha256: plaintextSha256, encryptedArchiveOnly: true });
  } catch {
    if (wrote) await rm(archivePath, { force: true }).catch(() => {});
    throw new Error("SYNTHETIC_SNAPSHOT_FAILED");
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** Verify encrypted snapshot in a disposable scratch directory; never restore a live database. */
export async function inspectSyntheticEncryptedSqliteSnapshot({ testRoot, archivePath, encryptionKey, expectedSyntheticLicenseStatus }) {
  // Explicit synthetic fixture assertion: prove that the archived WAL state,
  // not merely the still-open source database, contains the committed revoke.
  if (expectedSyntheticLicenseStatus !== undefined &&
      expectedSyntheticLicenseStatus !== "ACTIVE" && expectedSyntheticLicenseStatus !== "REVOKED") {
    throw new Error("SYNTHETIC_EXPECTED_STATUS_INVALID");
  }
  checkKey(encryptionKey);
  const root = await validateSandbox(testRoot, archivePath, true);
  const scratch = await mkdtemp(join(root.directory, "inspect-test-"));
  try {
    const archiveData = await readFile(root.target, "utf8");
    if (Buffer.byteLength(archiveData, "utf8") > MAX_BYTES * 2) throw new Error("SNAPSHOT_ARCHIVE_TOO_LARGE");
    const envelope = parseArchive(archiveData);
    const header = { schemaVersion: envelope.schemaVersion, algorithm: envelope.algorithm, plaintextSha256: envelope.plaintextSha256 };
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, envelope.nonce);
    decipher.setAAD(Buffer.from(JSON.stringify(header)));
    decipher.setAuthTag(envelope.tag);
    const decrypted = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
    if (!decrypted.length || decrypted.length > MAX_BYTES || sha(decrypted) !== envelope.plaintextSha256) {
      throw new Error("SNAPSHOT_INTEGRITY_INVALID");
    }
    const temporary = join(scratch, "inspected.sqlite");
    await writeFile(temporary, decrypted, { flag: "wx", mode: 0o600 });
    assertIntegrity(temporary);
    if (expectedSyntheticLicenseStatus !== undefined) {
      const db = new DatabaseSync(temporary, { readOnly: true });
      try {
        const row = db.prepare("SELECT status FROM licenses WHERE license_id = ?").get("synthetic-license");
        if (row?.status !== expectedSyntheticLicenseStatus) throw new Error("SYNTHETIC_WAL_STATE_MISMATCH");
      } finally { db.close(); }
    }
    return Object.freeze({ ok: true, sourceSnapshotSha256: envelope.plaintextSha256, sqliteIntegrity: "ok", restoresCustomerAccess: false });
  } catch {
    throw new Error("SYNTHETIC_SNAPSHOT_INSPECTION_DENIED");
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

export const SYNTHETIC_BACKUP_MARKER = MARKER;
