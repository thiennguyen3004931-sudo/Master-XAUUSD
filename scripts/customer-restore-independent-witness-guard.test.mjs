import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { compareRestoreWithIndependentWitness as compare } from "./customer-restore-independent-witness-guard.mjs";
import { issueRestoreAuthorityProof, issueRestoreWitnessProof } from "./customer-restore-authority-proof-issuer.mjs";
import { verifySignedRestoreAuthority } from "./customer-restore-authority-signed-proof.mjs";
import { fingerprintRestoreAuthorityKeyring } from "./customer-restore-authority-key-lifecycle.mjs";

const NOW = 1_800_000_000_000;
const NONCE = "synthetic-fresh-nonce-across-two-separate-authorities";
function pair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}
const operatorKey = pair();
const witnessKey = pair();
const rogueKey = pair();
const active = Object.freeze({
  customerId: "synthetic-customer", installationId: "synthetic-installation",
  licenseId: "synthetic-license", grantId: "synthetic-grant",
  bindingEpoch: "synthetic-binding-1", authorizationState: "ACTIVE",
  revocationGeneration: 1, migrationGeneration: 1,
  challengeConsumptionGeneration: 1, auditHighWater: 1, tokenGeneration: 1,
});
const operatorKeyring = { epoch: 7, keys: { operatorV1: {
  publicKeyPem: operatorKey.publicKeyPem, status: "ACTIVE",
  notBeforeMs: NOW - 30_000, notAfterMs: NOW + 30_000,
} } };
const witnessKeyring = { epoch: 11, keys: { witnessV1: {
  publicKeyPem: witnessKey.publicKeyPem, status: "ACTIVE",
  notBeforeMs: NOW - 30_000, notAfterMs: NOW + 30_000,
} } };
const roots = Object.freeze({
  operatorKeyring, operatorTrustedEpoch: 7,
  operatorTrustedDigest: fingerprintRestoreAuthorityKeyring(operatorKeyring),
  witnessKeyring, witnessTrustedEpoch: 11,
  witnessTrustedDigest: fingerprintRestoreAuthorityKeyring(witnessKeyring),
  // Test fixture only: a real checkpoint MUST be durably authenticated and
  // stored separately from both operator and witness restorable state.
  trustedWitnessCheckpoint: { ...active, witnessKeyringEpoch: 11 },
});
function sign(authority, role, key, nonce = NONCE, at = NOW) {
  const issuer = role === "witnessV1" ? issueRestoreWitnessProof : issueRestoreAuthorityProof;
  const proof = issuer({
    authority, authorityKeyId: role,
    privateKeyPem: key.privateKeyPem, requestNonce: nonce,
    nowMs: at, ttlMs: 10_000,
  });
  assert.equal(proof.ok, true);
  return proof;
}
function check(restored = active, options = {}) {
  return compare({
    restored,
    operatorProof: sign(active, "operatorV1", operatorKey),
    witnessProof: sign(active, "witnessV1", witnessKey),
    ...roots,
    expectedNonce: NONCE,
    nowMs: NOW + 1000,
    ...options,
  });
}
function denied(result, code) {
  assert.equal(result.evidenceMatched, false);
  assert.equal(result.customerAuthorizationAllowed, false);
  assert.equal(result.reasonCode, code);
}

test("two separately signed fresh matching synthetic proofs reconcile WITHOUT granting access", () => {
  const result = check();
  assert.deepEqual(result, {
    evidenceMatched: true,
    customerAuthorizationAllowed: false,
    reasonCode: "SYNTHETIC_SEPARATE_WITNESS_MATCH_ONLY",
  });
  assert.equal(Object.hasOwn(result, "allowed"), false);
  assert.equal(Object.hasOwn(result, "releaseAuthorized"), false);
});

for (const mode of ["SELF_MANAGED", "COPY_FOLLOWER"]) {
  test(mode + ": old customer backup plus rolled-back operator file is denied by latest independent witness", () => {
    const revokedAtWitness = {
      ...active, authorizationState: "REVOKED",
      revocationGeneration: 2, auditHighWater: 2,
    };
    // Attack restores BOTH customer and operator; old operator still signs ACTIVE.
    const oldOperatorProof = sign(active, "operatorV1", operatorKey);
    const oldCandidate = { ...active };
    assert.equal(verifySignedRestoreAuthority({
      restored: oldCandidate, statement: oldOperatorProof.statement,
      signatureBase64: oldOperatorProof.signatureBase64,
      trustedPublicKeys: { operatorV1: operatorKey.publicKeyPem },
      expectedNonce: NONCE, nowMs: NOW + 1000,
    }).allowed, true, "original single-proof check demonstrably accepts the combined rollback");

    const decision = check(oldCandidate, {
      operatorProof: oldOperatorProof,
      witnessProof: sign(revokedAtWitness, "witnessV1", witnessKey),
    });
    denied(decision, "INDEPENDENT_WITNESS_RESTORE_GENERATION_ROLLBACK");
  });
}

test("independent witness rejects restored challenge consumption and token rotation high-water rollback", () => {
  for (const counter of ["challengeConsumptionGeneration", "tokenGeneration", "migrationGeneration"]) {
    const newer = { ...active, [counter]: active[counter] + 1, auditHighWater: 2 };
    denied(check(active, {
      witnessProof: sign(newer, "witnessV1", witnessKey),
    }), "INDEPENDENT_WITNESS_RESTORE_GENERATION_ROLLBACK");
  }
});

test("newer customer/old operator proof cannot be reconciled by the separate witness", () => {
  const newer = { ...active, challengeConsumptionGeneration: 2, auditHighWater: 2 };
  denied(check(newer, {
    witnessProof: sign(newer, "witnessV1", witnessKey),
  }), "OPERATOR_PROOF_RESTORE_GENERATION_AHEAD_OF_AUTHORITY");
});

test("proofs with wrong witness signer and missing pinned root never reconcile", () => {
  denied(check(active, {
    witnessProof: sign(active, "witnessV1", rogueKey),
  }), "INDEPENDENT_WITNESS_AUTHORITY_SIGNATURE_INVALID");
  denied(check(active, {
    witnessKeyring: { epoch: 11, keys: {} },
  }), "INDEPENDENT_WITNESS_ROOT_UNAVAILABLE");
  denied(check(active, {
    witnessProof: undefined,
  }), "INDEPENDENT_WITNESS_REQUIRED");
});

test("same key under different IDs cannot masquerade as independent witness", () => {
  denied(check(active, {
    witnessProof: sign(active, "witnessV1", operatorKey),
    witnessKeyring: { epoch: 11, keys: { witnessV1: { ...witnessKeyring.keys.witnessV1, publicKeyPem: operatorKey.publicKeyPem } } },
  }), "INDEPENDENT_WITNESS_ROOT_NOT_SEPARATE");
});

test("cross-domain replay: an operator-domain signature cannot authenticate a witness proof", () => {
  const forgedWitness = issueRestoreAuthorityProof({
    authority: active, authorityKeyId: "witnessV1",
    privateKeyPem: witnessKey.privateKeyPem,
    requestNonce: NONCE, nowMs: NOW, ttlMs: 10_000,
  });
  assert.equal(forgedWitness.ok, true);
  denied(check(active, {
    witnessProof: forgedWitness,
  }), "INDEPENDENT_WITNESS_AUTHORITY_SIGNATURE_INVALID");
});

test("cross-domain replay: a witness-domain signature cannot authenticate an operator proof", () => {
  const forgedOperator = issueRestoreWitnessProof({
    authority: active, authorityKeyId: "operatorV1",
    privateKeyPem: operatorKey.privateKeyPem,
    requestNonce: NONCE, nowMs: NOW, ttlMs: 10_000,
  });
  assert.equal(forgedOperator.ok, true);
  denied(check(active, {
    operatorProof: forgedOperator,
  }), "OPERATOR_PROOF_AUTHORITY_SIGNATURE_INVALID");
});

test("trusted witness epoch/digest and revoked signer status are mandatory", () => {
  denied(check(active, {
    witnessTrustedDigest: "0".repeat(64),
  }), "INDEPENDENT_WITNESS_AUTHORITY_KEYRING_DIGEST_MISMATCH");
  denied(check(active, {
    witnessTrustedDigest: undefined,
  }), "INDEPENDENT_WITNESS_AUTHORITY_TRUSTED_KEYRING_DIGEST_MISSING");
  denied(check(active, {
    witnessTrustedEpoch: 12,
  }), "INDEPENDENT_WITNESS_AUTHORITY_KEYRING_ROLLBACK");
  denied(check(active, {
    operatorTrustedEpoch: 8,
  }), "OPERATOR_PROOF_AUTHORITY_KEYRING_ROLLBACK");
  const revokedKeyring = {
    epoch: 11, keys: {
      witnessV1: { ...witnessKeyring.keys.witnessV1, status: "REVOKED" },
    },
  };
  denied(check(active, {
    witnessKeyring: revokedKeyring,
    // Synthetic fixture simulates a pinned revised keyring; still denied.
    witnessTrustedDigest: fingerprintRestoreAuthorityKeyring(revokedKeyring),
  }), "INDEPENDENT_WITNESS_AUTHORITY_SIGNING_KEY_REVOKED");
});

test("substituted witness key at same epoch is refused by independently held digest", () => {
  const wrongRing = {
    epoch: 11,
    keys: { witnessV1: { ...witnessKeyring.keys.witnessV1, publicKeyPem: rogueKey.publicKeyPem } },
  };
  denied(check(active, {
    witnessKeyring: wrongRing,
  }), "INDEPENDENT_WITNESS_AUTHORITY_KEYRING_DIGEST_MISMATCH");
});


test("missing or malformed independently persisted checkpoint denies even matching dual signatures", () => {
  denied(check(active, { trustedWitnessCheckpoint: undefined }),
    "INDEPENDENT_CHECKPOINT_REQUIRED");
  denied(check(active, { trustedWitnessCheckpoint: {} }),
    "INDEPENDENT_CHECKPOINT_INVALID");
  denied(check(active, { trustedWitnessCheckpoint: {
    ...roots.trustedWitnessCheckpoint, tokenGeneration: -1,
  } }), "INDEPENDENT_CHECKPOINT_INVALID");
  denied(check(active, { trustedWitnessCheckpoint: {
    ...roots.trustedWitnessCheckpoint, untrustedExtra: true,
  } }), "INDEPENDENT_CHECKPOINT_INVALID");
});

for (const mode of ["SELF_MANAGED", "COPY_FOLLOWER"]) {
  test(mode + ": two freshly signed OLD proofs cannot bypass a newer trusted high-water floor", () => {
    const floor = {
      ...active, authorizationState: "REVOKED",
      revocationGeneration: 2, auditHighWater: 2, witnessKeyringEpoch: 11,
    };
    const bothOldProofs = check(active, {
      operatorProof: sign(active, "operatorV1", operatorKey),
      witnessProof: sign(active, "witnessV1", witnessKey),
      trustedWitnessCheckpoint: floor,
    });
    denied(bothOldProofs, "INDEPENDENT_CHECKPOINT_GENERATION_ROLLBACK");
    // This fixture deliberately demonstrates that a rolled-back *checkpoint*
    // would still pass the pure comparison: independence is an external gate.
    const restoredOldFloor = check(active);
    assert.equal(restoredOldFloor.evidenceMatched, true);
    assert.equal(restoredOldFloor.customerAuthorizationAllowed, false);
  });
}

test("checkpoint rejects rollback of all monotonic counters and witness signer epoch", () => {
  for (const counter of [
    "revocationGeneration", "migrationGeneration", "challengeConsumptionGeneration",
    "auditHighWater", "tokenGeneration",
  ]) {
    denied(check(active, { trustedWitnessCheckpoint: {
      ...roots.trustedWitnessCheckpoint, [counter]: 2,
    } }), "INDEPENDENT_CHECKPOINT_GENERATION_ROLLBACK");
  }
  denied(check(active, {
    trustedWitnessCheckpoint: { ...roots.trustedWitnessCheckpoint, witnessKeyringEpoch: 12 },
  }), "INDEPENDENT_CHECKPOINT_EPOCH_ROLLBACK");
});

test("checkpoint binding conflict and prior revoked/expired states always fail closed", () => {
  denied(check(active, { trustedWitnessCheckpoint: {
    ...roots.trustedWitnessCheckpoint, bindingEpoch: "different-binding",
  } }), "INDEPENDENT_CHECKPOINT_BINDING_MISMATCH");
  for (const state of ["REVOKED", "EXPIRED"]) {
    denied(check(active, { trustedWitnessCheckpoint: {
      ...roots.trustedWitnessCheckpoint, authorizationState: state,
    } }), "INDEPENDENT_CHECKPOINT_NOT_ACTIVE");
  }
});

test("witness signature replay for a different nonce or after expiry is rejected", () => {
  denied(check(active, {
    witnessProof: sign(active, "witnessV1", witnessKey, "nonce-from-old-restore-request-123456"),
  }), "INDEPENDENT_WITNESS_AUTHORITY_NONCE_OR_VERSION_INVALID");
  denied(check(active, {
    nowMs: NOW + 10_000,
  }), "OPERATOR_PROOF_AUTHORITY_FRESHNESS_INVALID");
});

test("identity replacement, missing witness, and invalid root format all fail closed", () => {
  denied(check({ ...active, installationId: "another-synthetic-installation" }),
    "OPERATOR_PROOF_RESTORE_BINDING_MISMATCH");
  denied(check(active, { witnessKeyring: { epoch: 11, keys: { witnessV1: { ...witnessKeyring.keys.witnessV1, publicKeyPem: "malformed-public-key" } } } }),
    "INDEPENDENT_WITNESS_ROOT_INVALID");
  denied(compare(), "INDEPENDENT_WITNESS_REQUIRED");
});

test("current revoked authority never grants customer access even if both signatures agree", () => {
  const revoked = { ...active, authorizationState: "REVOKED", revocationGeneration: 2, auditHighWater: 2 };
  denied(check(revoked, {
    operatorProof: sign(revoked, "operatorV1", operatorKey),
    witnessProof: sign(revoked, "witnessV1", witnessKey),
  }), "OPERATOR_PROOF_RESTORE_NOT_ACTIVE");
});
