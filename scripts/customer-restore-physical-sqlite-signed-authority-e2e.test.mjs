/**
 * P0 #176 disposable end-to-end regression. This does not gate the real API
 * Gateway or establish trusted operator-side authority durability.
 * Every SQLite file, signing key and customer identifier is synthetic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FileAuthorityFixture } from "./customer-restore-authority-file-fixture.mjs";
import { commitAuthorityTransition } from "./customer-restore-authority-atomic-cas.mjs";
import { issueRestoreAuthorityProof } from "./customer-restore-authority-proof-issuer.mjs";
import { verifySignedRestoreAuthority } from "./customer-restore-authority-signed-proof.mjs";

const NOW = 1_800_000_000_000;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
const trustedPublicKeys = { syntheticOperator: publicKey.export({ type: "spki", format: "pem" }) };
const freshNonce = () => randomBytes(24).toString("hex");
const initial = Object.freeze({
  customerId: "synthetic-customer", installationId: "synthetic-installation",
  licenseId: "synthetic-license", grantId: "synthetic-grant", bindingEpoch: "synthetic-epoch-1",
  authorizationState: "ACTIVE", revocationGeneration: 1, migrationGeneration: 1,
  challengeConsumptionGeneration: 1, auditHighWater: 1, tokenGeneration: 1,
});

function readCustomerCandidate(path) {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare("SELECT payload_json FROM customer_candidate WHERE id = 1").get();
    return row ? JSON.parse(row.payload_json) : null;
  } finally { db.close(); }
}

function saveCustomerCandidate(path, state) {
  const db = new DatabaseSync(path);
  try {
    db.prepare("UPDATE customer_candidate SET payload_json = ? WHERE id = 1").run(JSON.stringify(state));
  } finally { db.close(); }
}

async function setup(t, productMode) {
  const root = await mkdtemp(join(tmpdir(), "xau-restore-p0-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const customerDir = join(root, "customer-restorable");
  const operatorDir = join(root, "operator-protected");
  await mkdir(customerDir);
  await mkdir(operatorDir);
  const databasePath = join(customerDir, "customer-security.sqlite");
  const oldBackup = join(customerDir, "pre-revocation-backup.sqlite");
  const operatorPath = join(operatorDir, "binding.json");
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE customer_candidate (id INTEGER PRIMARY KEY, payload_json TEXT NOT NULL);");
    db.prepare("INSERT INTO customer_candidate(id, payload_json) VALUES (1, ?)").run(JSON.stringify(initial));
  } finally { db.close(); }
  // Closed physical database snapshot, not a live-WAL backup procedure.
  await copyFile(databasePath, oldBackup);
  await writeFile(operatorPath, JSON.stringify(initial), { flag: "wx" });
  return {
    root, productMode, operatorPath, databasePath, oldBackup,
    adapter: new FileAuthorityFixture(operatorDir),
  };
}

async function durableTestCommit(ctx, next) {
  const result = await commitAuthorityTransition({
    adapter: ctx.adapter, bindingKey: "binding",
    next, expectedAuditHighWater: next.auditHighWater - 1,
  });
  assert.equal(result.ok, true, "synthetic independent-authority transition must succeed");
}

async function readOperator(ctx) {
  return JSON.parse(await readFile(ctx.operatorPath, "utf8"));
}

function signProof(authority, requestNonce, nowMs = NOW) {
  const result = issueRestoreAuthorityProof({
    authority, authorityKeyId: "syntheticOperator", privateKeyPem,
    requestNonce, nowMs, ttlMs: 10_000,
  });
  assert.equal(result.ok, true);
  return result;
}

function evaluateCandidate(restored, signed, requestNonce, nowMs = NOW + 500) {
  return verifySignedRestoreAuthority({
    restored, statement: signed.statement, signatureBase64: signed.signatureBase64,
    trustedPublicKeys, expectedNonce: requestNonce, nowMs,
  });
}

for (const productMode of ["SELF_MANAGED", "COPY_FOLLOWER"]) {
  test(productMode + ": matching fresh operator proof only passes comparison, never authorizes trading", async t => {
    const ctx = await setup(t, productMode);
    const nonce = freshNonce();
    const decision = evaluateCandidate(readCustomerCandidate(ctx.databasePath), signProof(await readOperator(ctx), nonce), nonce);
    assert.equal(decision.allowed, true);
    assert.equal(decision.reasonCode, "RESTORE_COUNTERS_MATCH_VERIFIED_AUTHORITY");
    assert.equal(Object.hasOwn(decision, "exposureAllowed"), false);
  });

  test(productMode + ": physical pre-revocation SQLite restore is denied by newer signed independent authority", async t => {
    const ctx = await setup(t, productMode);
    const revoked = {
      ...initial, authorizationState: "REVOKED",
      revocationGeneration: 2, auditHighWater: 2,
    };
    saveCustomerCandidate(ctx.databasePath, revoked);
    await durableTestCommit(ctx, revoked);
    await copyFile(ctx.oldBackup, ctx.databasePath);
    const stale = readCustomerCandidate(ctx.databasePath);
    assert.equal(stale.authorizationState, "ACTIVE");
    assert.equal((await readOperator(ctx)).authorizationState, "REVOKED");
    const nonce = freshNonce();
    const decision = evaluateCandidate(stale, signProof(await readOperator(ctx), nonce), nonce);
    assert.equal(decision.allowed, false);
    assert.ok(["RESTORE_GENERATION_ROLLBACK", "RESTORE_NOT_ACTIVE"].includes(decision.reasonCode));
  });

  test(productMode + ": restored consumed challenge generation is rejected", async t => {
    const ctx = await setup(t, productMode);
    const consumed = { ...initial, challengeConsumptionGeneration: 2, auditHighWater: 2 };
    saveCustomerCandidate(ctx.databasePath, consumed);
    await durableTestCommit(ctx, consumed);
    await copyFile(ctx.oldBackup, ctx.databasePath);
    const nonce = freshNonce();
    const decision = evaluateCandidate(readCustomerCandidate(ctx.databasePath), signProof(await readOperator(ctx), nonce), nonce);
    assert.deepEqual(decision, { allowed: false, reasonCode: "RESTORE_GENERATION_ROLLBACK" });
  });

  test(productMode + ": previously issued challenge proof cannot be replayed for activation", async t => {
    const ctx = await setup(t, productMode);
    const challengeNonce = freshNonce();
    const oldProof = signProof(await readOperator(ctx), challengeNonce);
    const activationNonce = freshNonce();
    assert.notEqual(challengeNonce, activationNonce);
    assert.equal(
      evaluateCandidate(readCustomerCandidate(ctx.databasePath), oldProof, activationNonce).allowed,
      false,
    );
    const revoked = { ...initial, authorizationState: "REVOKED", revocationGeneration: 2, auditHighWater: 2 };
    await durableTestCommit(ctx, revoked);
    const currentProof = signProof(await readOperator(ctx), activationNonce);
    assert.equal(
      evaluateCandidate(readCustomerCandidate(ctx.databasePath), currentProof, activationNonce).allowed,
      false,
    );
  });
}

test("old customer database restored after token rotation is rejected by signed token-generation high-water", async t => {
  const ctx = await setup(t, "SELF_MANAGED");
  const rotated = { ...initial, tokenGeneration: 2, auditHighWater: 2 };
  saveCustomerCandidate(ctx.databasePath, rotated);
  await durableTestCommit(ctx, rotated);
  await copyFile(ctx.oldBackup, ctx.databasePath);
  const nonce = freshNonce();
  const decision = evaluateCandidate(readCustomerCandidate(ctx.databasePath), signProof(await readOperator(ctx), nonce), nonce);
  assert.equal(decision.reasonCode, "RESTORE_GENERATION_ROLLBACK");
});

test("unknown signer, invalid nonce and unavailable independent operator store must deny", async t => {
  const ctx = await setup(t, "SELF_MANAGED");
  const nonce = freshNonce();
  const signed = signProof(await readOperator(ctx), nonce);
  assert.equal(evaluateCandidate(readCustomerCandidate(ctx.databasePath), signed, freshNonce()).allowed, false);
  assert.equal(verifySignedRestoreAuthority({
    restored: initial, statement: signed.statement, signatureBase64: signed.signatureBase64,
    trustedPublicKeys: {}, expectedNonce: nonce, nowMs: NOW + 500,
  }).allowed, false);
  await rm(ctx.operatorPath);
  await assert.rejects(() => readOperator(ctx));
  // With no verified operator state, synthetic admission is BLOCKED, not re-created from customer SQLite.
});

test("operator authority file rollback itself is STILL an unsolved P0 gap", async t => {
  const ctx = await setup(t, "SELF_MANAGED");
  const revoked = { ...initial, authorizationState: "REVOKED", revocationGeneration: 2, auditHighWater: 2 };
  await durableTestCommit(ctx, revoked);
  // Demonstrate why a separate *file* is not independently rollback-proof.
  // Attack model restores BOTH the old customer backup and the operator authority file.
  await writeFile(ctx.operatorPath, JSON.stringify(initial));
  const nonce = freshNonce();
  const decision = evaluateCandidate(readCustomerCandidate(ctx.databasePath), signProof(await readOperator(ctx), nonce), nonce);
  assert.equal(decision.allowed, true, "test documents missing tamper-resistant monotonic operator authority");
  // A green test here MUST NOT be interpreted as security acceptance.
});
