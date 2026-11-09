import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifySignedRestoreAuthority as check, RESTORE_AUTHORITY_SIGNING_FIELDS as FIELDS, RESTORE_AUTHORITY_SIGNING_DOMAIN as DOMAIN } from "./customer-restore-authority-signed-proof.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const trustedPublicKeys = { key1: publicKey.export({ type: "spki", format: "pem" }) };
const nowMs = 1_800_000_000_000;
const restored = { customerId: "a", installationId: "b", licenseId: "c", grantId: "d", bindingEpoch: "e", authorizationState: "ACTIVE", revocationGeneration: 3, migrationGeneration: 2, challengeConsumptionGeneration: 5, auditHighWater: 9, tokenGeneration: 1 };
const statement = { schemaVersion: 1, authorityKeyId: "key1", issuedAt: nowMs - 1000, expiresAt: nowMs + 1000, requestNonce: "fresh-unique-nonce", ...restored };
const signature = (s) => sign(null, Buffer.from(DOMAIN + JSON.stringify(FIELDS.map(k => s[k])), "utf8"), privateKey).toString("base64");
const evaluate = (s=statement, sig=signature(s), opts={}) => check({ restored, statement:s, signatureBase64:sig, trustedPublicKeys, expectedNonce:statement.requestNonce, nowMs, ...opts });

test("valid signed proof permits comparison only", () => assert.equal(evaluate().allowed, true));
test("tampered statement rejected", () => assert.equal(evaluate({ ...statement, revocationGeneration: 0 }, signature(statement)).allowed, false));
test("wrong nonce rejected", () => assert.equal(evaluate(statement, signature(statement), { expectedNonce: "different" }).allowed, false));
test("expired proof rejected", () => assert.equal(evaluate({ ...statement, expiresAt: nowMs - 1 }).allowed, false));
test("future issuedAt rejected", () => assert.equal(evaluate({ ...statement, issuedAt: nowMs + 1 }).allowed, false));
test("too-long proof lifetime rejected", () => assert.equal(evaluate({ ...statement, expiresAt: nowMs + 120000 }).allowed, false));
test("unknown key rejected", () => assert.equal(evaluate({ ...statement, authorityKeyId: "missing" }).allowed, false));
test("extra fields rejected", () => assert.equal(evaluate({ ...statement, extra: true }).allowed, false));
test("invalid signature rejected", () => assert.equal(evaluate(statement, "AAAA").allowed, false));
test("revoked signed authority cannot revive license", () => assert.equal(evaluate({ ...statement, authorizationState: "REVOKED" }).allowed, false));
test("stale snapshot rejected against signed higher watermark", () => assert.equal(evaluate({ ...statement, tokenGeneration: 2 }).allowed, false));
test("no trust roots rejected", () => assert.equal(evaluate(statement, signature(statement), { trustedPublicKeys: {} }).allowed, false));

// P0 regression: signing a structurally valid but security-inconsistent authority must not admit a restored state.
test("validly signed higher revocation generation blocks restored snapshot", () => {
  const newer = { ...statement, revocationGeneration: statement.revocationGeneration + 1 };
  assert.equal(evaluate(newer).reasonCode, "RESTORE_GENERATION_ROLLBACK");
});
test("validly signed higher consumed challenge generation blocks restore", () => {
  const newer = { ...statement, challengeConsumptionGeneration: statement.challengeConsumptionGeneration + 1 };
  assert.equal(evaluate(newer).reasonCode, "RESTORE_GENERATION_ROLLBACK");
});
test("validly signed higher audit high-water blocks restore", () => {
  const newer = { ...statement, auditHighWater: statement.auditHighWater + 1 };
  assert.equal(evaluate(newer).reasonCode, "RESTORE_GENERATION_ROLLBACK");
});
test("validly signed higher token generation blocks restore", () => {
  const newer = { ...statement, tokenGeneration: statement.tokenGeneration + 1 };
  assert.equal(evaluate(newer).reasonCode, "RESTORE_GENERATION_ROLLBACK");
});
test("validly signed mismatched installation is rejected", () => {
  const swapped = { ...statement, installationId: "other-installation" };
  assert.equal(evaluate(swapped).reasonCode, "RESTORE_BINDING_MISMATCH");
});
test("validly signed revoked authority is denied even if counters match", () => {
  const revoked = { ...statement, authorizationState: "REVOKED" };
  assert.equal(evaluate(revoked).reasonCode, "RESTORE_NOT_ACTIVE");
});
test("validly signed expired license is denied even if counters match", () => {
  const expired = { ...statement, authorizationState: "EXPIRED" };
  assert.equal(evaluate(expired).reasonCode, "RESTORE_NOT_ACTIVE");
});
test("signature cannot be reused under a different domain", () => {
  const wrongDomain = sign(null, Buffer.from("UNRELATED-PROTOCOL\\n" + JSON.stringify(FIELDS.map(k => statement[k]))), privateKey).toString("base64");
  assert.equal(evaluate(statement, wrongDomain).reasonCode, "AUTHORITY_SIGNATURE_INVALID");
});
test("validly signed unknown future schema version is rejected", () => {
  const future = { ...statement, schemaVersion: 2 };
  assert.equal(evaluate(future).reasonCode, "AUTHORITY_NONCE_OR_VERSION_INVALID");
});
