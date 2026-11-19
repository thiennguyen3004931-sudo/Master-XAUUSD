import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { issueRestoreAuthorityProof } from "./customer-restore-authority-proof-issuer.mjs";
import { verifyRestoreAuthorityWithKeyLifecycle as verify, fingerprintRestoreAuthorityKeyring as fingerprint } from "./customer-restore-authority-key-lifecycle.mjs";

// Synthetic keys, identities and authority counters only; no operator KMS.
const NOW = 1_900_000_000_000;
const makeKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
};
const first = makeKey();
const second = makeKey();
const authority = Object.freeze({
  customerId: "synthetic-customer", installationId: "synthetic-installation",
  licenseId: "synthetic-license", grantId: "synthetic-grant",
  bindingEpoch: "synthetic-binding-epoch",
  authorizationState: "ACTIVE", revocationGeneration: 3,
  migrationGeneration: 2, challengeConsumptionGeneration: 5,
  auditHighWater: 9, tokenGeneration: 4,
});
const nonce = "synthetic-fresh-request-nonce-0123456789";
const entry = (key, status = "ACTIVE", notBeforeMs = NOW - 30_000, notAfterMs = NOW + 30_000) =>
  ({ publicKeyPem: key.publicKeyPem, status, notBeforeMs, notAfterMs });
const ring = (epoch = 7, keys = { operatorV1: entry(first) }) => ({ epoch, keys });
const proof = (key = first, authorityKeyId = "operatorV1", state = authority) => {
  const issued = issueRestoreAuthorityProof({
    authority: state, authorityKeyId, privateKeyPem: key.privateKeyPem,
    requestNonce: nonce, nowMs: NOW, ttlMs: 10_000,
  });
  assert.equal(issued.ok, true);
  return issued;
};
const decide = (signed, overrides = {}) => {
  const keyring = Object.hasOwn(overrides, "keyring") ? overrides.keyring : ring();
  // Test-only simulation of an independently pinned digest. Production MUST
  // obtain this pin from a separate durable authenticated trust root.
  const trustedKeyringSha256Hex = Object.hasOwn(overrides, "trustedKeyringSha256Hex")
    ? overrides.trustedKeyringSha256Hex : fingerprint(keyring);
  return verify({
    restored: authority, statement: signed.statement,
    signatureBase64: signed.signatureBase64,
    keyring, trustedKeyringEpoch: 7, trustedKeyringSha256Hex,
    expectedNonce: nonce, nowMs: NOW + 500,
    ...overrides,
  });
};
const reason = (result, expected) => {
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, expected);
};

test("matching synthetic Ed25519 proof with active signer and pinned epoch only passes comparison", () => {
  const decision = decide(proof());
  assert.deepEqual(decision, {
    allowed: true, reasonCode: "RESTORE_COUNTERS_MATCH_VERIFIED_AUTHORITY",
  });
  assert.equal(Object.hasOwn(decision, "exposureAllowed"), false);
});

test("independent trusted epoch rejects old or unverified keyring epochs", () => {
  reason(decide(proof(), { keyring: ring(6) }), "AUTHORITY_KEYRING_ROLLBACK");
  reason(decide(proof(), { keyring: ring(8) }), "AUTHORITY_KEYRING_UNVERIFIED_EPOCH");
  reason(decide(proof(), { trustedKeyringEpoch: undefined }), "AUTHORITY_TRUST_ANCHOR_MISSING");
  reason(decide(proof(), { trustedKeyringEpoch: 0 }), "AUTHORITY_TRUST_ANCHOR_MISSING");
});

test("same-epoch substituted public key or revocation state is denied by independently pinned digest", () => {
  const originalPin = fingerprint(ring());
  assert.match(originalPin, /^[0-9a-f]{64}$/);
  reason(decide(proof(), {
    keyring: ring(7, { operatorV1: entry(second) }),
    trustedKeyringSha256Hex: originalPin,
  }), "AUTHORITY_KEYRING_DIGEST_MISMATCH");
  reason(decide(proof(), {
    keyring: ring(7, { operatorV1: entry(first, "REVOKED") }),
    trustedKeyringSha256Hex: originalPin,
  }), "AUTHORITY_KEYRING_DIGEST_MISMATCH");
  reason(decide(proof(), { trustedKeyringSha256Hex: undefined }),
    "AUTHORITY_TRUSTED_KEYRING_DIGEST_MISSING");
});

test("revoked signing key rejects even a previously valid, unexpired signature", () => {
  reason(decide(proof(), { keyring: ring(7, { operatorV1: entry(first, "REVOKED") }) }),
    "AUTHORITY_SIGNING_KEY_REVOKED");
});

test("rotation accepts new signer but refuses old signer at the same pinned epoch", () => {
  const keys = { operatorV1: entry(first, "REVOKED"), operatorV2: entry(second) };
  reason(decide(proof(), { keyring: ring(8, keys), trustedKeyringEpoch: 8 }),
    "AUTHORITY_SIGNING_KEY_REVOKED");
  assert.equal(decide(proof(second, "operatorV2"), {
    keyring: ring(8, keys), trustedKeyringEpoch: 8,
  }).allowed, true);
});

test("expired, future and short validity windows fail closed", () => {
  reason(decide(proof(), { keyring: ring(7, {
    operatorV1: entry(first, "ACTIVE", NOW - 60_000, NOW + 100),
  }) }), "AUTHORITY_SIGNING_KEY_OUTSIDE_VALIDITY");
  reason(decide(proof(), { keyring: ring(7, {
    operatorV1: entry(first, "ACTIVE", NOW + 1000, NOW + 60_000),
  }) }), "AUTHORITY_SIGNING_KEY_OUTSIDE_VALIDITY");
  reason(decide(proof(), { nowMs: NOW + 30_000 }), "AUTHORITY_SIGNING_KEY_OUTSIDE_VALIDITY");
});

test("unknown, missing or malformed signer records never fall back to another key", () => {
  reason(decide(proof(), { keyring: ring(7, { operatorV2: entry(second) }) }),
    "AUTHORITY_SIGNING_KEY_UNKNOWN");
  reason(decide(proof(), { keyring: { epoch: 7, keys: {} } }),
    "AUTHORITY_KEYRING_INVALID");
  reason(decide(proof(), { keyring: { epoch: 7, keys: { operatorV1: { publicKeyPem: first.publicKeyPem } } } }),
    "AUTHORITY_KEYRING_INVALID");
  reason(decide(proof(), { keyring: null }), "AUTHORITY_KEYRING_INVALID");
  reason(decide(proof(), { keyring: { epoch: 7, keys: {}, extra: true } }),
    "AUTHORITY_KEYRING_INVALID");
});

test("signature mismatch, wrong nonce, stale counters and revoked authority remain denied", () => {
  reason(decide(proof(), { keyring: ring(7, { operatorV1: entry(second) }) }),
    "AUTHORITY_SIGNATURE_INVALID");
  reason(decide(proof(), { expectedNonce: "different-request-nonce" }),
    "AUTHORITY_NONCE_OR_VERSION_INVALID");
  reason(decide(proof(), { restored: { ...authority, tokenGeneration: 3 } }),
    "RESTORE_GENERATION_ROLLBACK");
  const revoked = { ...authority, authorizationState: "REVOKED" };
  reason(decide(proof(first, "operatorV1", revoked), { restored: revoked }),
    "RESTORE_NOT_ACTIVE");
});

test("malformed caller inputs deny instead of throwing or enabling access", () => {
  reason(verify(), "AUTHORITY_TRUST_ANCHOR_MISSING");
  reason(decide(proof(), { nowMs: Number.NaN }), "AUTHORITY_TRUST_ANCHOR_MISSING");
  const signed = proof();
  reason(decide({ ...signed, statement: { ...signed.statement, authorityKeyId: "__proto__" } }),
    "AUTHORITY_SIGNING_KEY_UNKNOWN");
});
