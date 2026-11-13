import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  createSyntheticEncryptedSqliteSnapshot as create,
  inspectSyntheticEncryptedSqliteSnapshot as inspect,
  SYNTHETIC_BACKUP_MARKER,
} from "./customer-sqlite-encrypted-snapshot.mjs";

async function fixture(t, { marker = true } = {}) {
  const testRoot = await mkdtemp(join(tmpdir(), "xau-sqlite-aead-test-"));
  t.after(() => rm(testRoot, { force: true, recursive: true, maxRetries: 6, retryDelay: 100 }));
  if (marker) await writeFile(join(testRoot, ".xau-synthetic-only"), SYNTHETIC_BACKUP_MARKER);
  await mkdir(join(testRoot, "snapshots"));
  const sourcePath = join(testRoot, "active.sqlite");
  const archivePath = join(testRoot, "snapshots", "accepted.sqlite.aead.json");
  const encryptionKey = randomBytes(32);
  const db = new DatabaseSync(sourcePath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE licenses (license_id TEXT PRIMARY KEY, status TEXT NOT NULL);");
  db.prepare("INSERT INTO licenses (license_id,status) VALUES ('synthetic-license', 'ACTIVE')").run();
  return { testRoot, sourcePath, archivePath, encryptionKey, db };
}

test("online backup includes committed WAL changes while source SQLite connection remains open", async t => {
  const f = await fixture(t);
  try {
    f.db.prepare("UPDATE licenses SET status='REVOKED' WHERE license_id='synthetic-license'").run();
    const created = await create(f);
    assert.equal(created.ok, true);
    assert.equal(created.encryptedArchiveOnly, true);
    // Inspect the decrypted archived SQLite itself: a source-only check could
    // pass even when a broken backup silently omits the committed WAL pages.
    const inspection = await inspect({ ...f, expectedSyntheticLicenseStatus: "REVOKED" });
    assert.equal(inspection.sqliteIntegrity, "ok");
    await assert.rejects(() => inspect({ ...f, expectedSyntheticLicenseStatus: "ACTIVE" }),
      /SYNTHETIC_SNAPSHOT_INSPECTION_DENIED/);
    assert.equal(inspection.sourceSnapshotSha256, created.sourceSnapshotSha256);
    assert.equal(inspection.restoresCustomerAccess, false);
    const entries = await readdir(f.testRoot);
    assert.equal(entries.some(name => name.startsWith("snapshot-test-") || name.startsWith("inspect-test-")), false);
    // A snapshot inspection is not a restore or authority admission.
    assert.equal(f.db.prepare("SELECT status FROM licenses WHERE license_id='synthetic-license'").get().status, "REVOKED");
  } finally { f.db.close(); }
});

test("wrong AES-GCM key denies inspection without emitting plaintext", async t => {
  const f = await fixture(t);
  try {
    await create(f);
    await assert.rejects(() => inspect({ ...f, encryptionKey: randomBytes(32) }),
      /SYNTHETIC_SNAPSHOT_INSPECTION_DENIED/);
  } finally { f.db.close(); }
});

test("modified ciphertext and authenticated metadata both fail closed", async t => {
  const f = await fixture(t);
  try {
    await create(f);
    const original = JSON.parse(await readFile(f.archivePath, "utf8"));
    const corrupted = Buffer.from(original.ciphertext, "base64");
    corrupted[0] ^= 1;
    await writeFile(f.archivePath, JSON.stringify({ ...original, ciphertext: corrupted.toString("base64") }));
    await assert.rejects(() => inspect(f), /SYNTHETIC_SNAPSHOT_INSPECTION_DENIED/);
    await writeFile(f.archivePath, JSON.stringify({ ...original, plaintextSha256: "0".repeat(64) }));
    await assert.rejects(() => inspect(f), /SYNTHETIC_SNAPSHOT_INSPECTION_DENIED/);
  } finally { f.db.close(); }
});

test("archive never overwrites an existing file", async t => {
  const f = await fixture(t);
  try {
    await writeFile(f.archivePath, "immutable-existing-artifact");
    await assert.rejects(() => create(f), /SYNTHETIC_SNAPSHOT_FAILED/);
    assert.equal(await readFile(f.archivePath, "utf8"), "immutable-existing-artifact");
  } finally { f.db.close(); }
});

test("synthetic sandbox marker required and absent operator key rejected", async t => {
  const f = await fixture(t, { marker: false });
  try {
    await assert.rejects(() => create(f));
    await assert.rejects(() => create({ ...f, encryptionKey: Buffer.alloc(12) }),
      /SYNTHETIC_ENCRYPTION_KEY_INVALID/);
  } finally { f.db.close(); }
});

test("cross-sandbox source paths are rejected", async t => {
  const a = await fixture(t);
  const b = await fixture(t);
  try {
    await assert.rejects(() => create({ ...a, sourcePath: b.sourcePath }));
  } finally {
    a.db.close();
    b.db.close();
  }
});

test("malformed archive cannot pass authenticated inspection", async t => {
  const f = await fixture(t);
  try {
    await writeFile(f.archivePath, "{unparseable");
    await assert.rejects(() => inspect(f), /SYNTHETIC_SNAPSHOT_INSPECTION_DENIED/);
  } finally { f.db.close(); }
});

test("unapproved production-looking root fails without snapshotting anything", async t => {
  const f = await fixture(t);
  try {
    await assert.rejects(() => create({ ...f, testRoot: "/usr" }));
  } finally { f.db.close(); }
});
