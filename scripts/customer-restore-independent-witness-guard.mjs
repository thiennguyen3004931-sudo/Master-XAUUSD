/**
 * P0 #176, PURE SYNTHETIC REVIEW HELPER ONLY.
 *
 * Two DIFFERENT pinned signature roots and independently verified keyring
 * epochs must validate a fresh candidate and separately obtained high-water witness.
 * Witness signatures use a purpose-specific domain and a previously trusted
 * independent monotonic checkpoint is required. Neither check establishes that
 * trusted root is independently administered, the witness is non-rollbackable,
 * or a live customer Gateway is safe to start. Never wire into live startup.
 *
 * No filesystem, network, Gateway, MT5, key issuance, or customer mutation.
 */
import { createPublicKey } from "node:crypto";
import { verifyRestoreAuthorityWithKeyLifecycle, verifyRestoreWitnessWithKeyLifecycle } from "./customer-restore-authority-key-lifecycle.mjs";

const reject = reasonCode => Object.freeze({
  evidenceMatched: false, customerAuthorizationAllowed: false, reasonCode,
});
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

const BINDING = Object.freeze(["customerId", "installationId", "licenseId", "grantId", "bindingEpoch"]);
const COUNTERS = Object.freeze([
  "revocationGeneration", "migrationGeneration", "challengeConsumptionGeneration",
  "auditHighWater", "tokenGeneration",
]);
const FLOOR_FIELDS = Object.freeze([
  ...BINDING, ...COUNTERS, "authorizationState", "witnessKeyringEpoch",
]);
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;

/**
 * A previously trusted, externally persisted high-water checkpoint is required,
 * even if TWO current request-bound signatures validate. This is only a pure
 * comparison; the caller MUST independently authenticate the checkpoint and
 * prove it cannot be rolled back together with either signed statement.
 */
function compareToTrustedCheckpoint(witness, checkpoint, witnessTrustedEpoch) {
  if (!object(checkpoint)) return "INDEPENDENT_CHECKPOINT_REQUIRED";
  if (Object.keys(checkpoint).sort().join("|") !== [...FLOOR_FIELDS].sort().join("|") ||
      !["ACTIVE", "REVOKED", "EXPIRED"].includes(checkpoint.authorizationState) ||
      !Number.isSafeInteger(checkpoint.witnessKeyringEpoch) ||
      checkpoint.witnessKeyringEpoch < 1) return "INDEPENDENT_CHECKPOINT_INVALID";
  for (const field of BINDING) {
    if (typeof checkpoint[field] !== "string" || !checkpoint[field] ||
        checkpoint[field] !== witness[field]) return "INDEPENDENT_CHECKPOINT_BINDING_MISMATCH";
  }
  for (const field of COUNTERS) {
    if (!nonnegative(checkpoint[field])) return "INDEPENDENT_CHECKPOINT_INVALID";
    if (!nonnegative(witness[field]) || witness[field] < checkpoint[field]) {
      return "INDEPENDENT_CHECKPOINT_GENERATION_ROLLBACK";
    }
  }
  if (!Number.isSafeInteger(witnessTrustedEpoch) ||
      witnessTrustedEpoch < checkpoint.witnessKeyringEpoch) {
    return "INDEPENDENT_CHECKPOINT_EPOCH_ROLLBACK";
  }
  // A previously witnessed REVOKED/EXPIRED state cannot silently be restored
  // to ACTIVE. Reissue needs a new audited binding and independent approval.
  if (checkpoint.authorizationState !== "ACTIVE") return "INDEPENDENT_CHECKPOINT_NOT_ACTIVE";
  return null;
}

/**
 * A result of evidenceMatched=true is a synthetic cross-proof comparison,
 * NOT an admission decision, release signature or license activation.
 *
 * The witness keyring, digest/epoch, fresh proof AND monotonic checkpoint MUST
 * originate from a separately controlled, authenticated anti-rollback domain.
 * Caller-supplied values alone do not supply that security boundary.
 */
export function compareRestoreWithIndependentWitness({
  restored, operatorProof, operatorKeyring, operatorTrustedEpoch, operatorTrustedDigest,
  witnessProof, witnessKeyring, witnessTrustedEpoch, witnessTrustedDigest,
  trustedWitnessCheckpoint, expectedNonce, nowMs,
} = {}) {
  if (!object(restored) || !object(operatorProof) || !object(witnessProof) ||
      !object(operatorProof.statement) || !object(witnessProof.statement) ||
      !object(operatorKeyring) || !object(witnessKeyring) ||
      !object(operatorKeyring.keys) || !object(witnessKeyring.keys) ||
      typeof expectedNonce !== "string" || expectedNonce.length < 16 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) {
    return reject("INDEPENDENT_WITNESS_REQUIRED");
  }
  if (!object(trustedWitnessCheckpoint)) return reject("INDEPENDENT_CHECKPOINT_REQUIRED");
  const operatorKeyId = operatorProof.statement.authorityKeyId;
  const witnessKeyId = witnessProof.statement.authorityKeyId;
  if (typeof operatorKeyId !== "string" || typeof witnessKeyId !== "string" ||
      !Object.hasOwn(operatorKeyring.keys, operatorKeyId) ||
      !Object.hasOwn(witnessKeyring.keys, witnessKeyId)) {
    return reject("INDEPENDENT_WITNESS_ROOT_UNAVAILABLE");
  }
  // Reject accidentally using the same key material in both proof roles,
  // even if it is aliased under different IDs or PEM whitespace.
  try {
    const operatorKey = createPublicKey(operatorKeyring.keys[operatorKeyId].publicKeyPem);
    const witnessKey = createPublicKey(witnessKeyring.keys[witnessKeyId].publicKeyPem);
    if (operatorKey.asymmetricKeyType !== "ed25519" ||
        witnessKey.asymmetricKeyType !== "ed25519" ||
        operatorKey.export({ type: "spki", format: "der" }).equals(
          witnessKey.export({ type: "spki", format: "der" }),
        )) {
      return reject("INDEPENDENT_WITNESS_ROOT_NOT_SEPARATE");
    }
  } catch {
    return reject("INDEPENDENT_WITNESS_ROOT_INVALID");
  }

  const operatorDecision = verifyRestoreAuthorityWithKeyLifecycle({
    restored,
    statement: operatorProof.statement,
    signatureBase64: operatorProof.signatureBase64,
    keyring: operatorKeyring, trustedKeyringEpoch: operatorTrustedEpoch,
    trustedKeyringSha256Hex: operatorTrustedDigest,
    expectedNonce, nowMs,
  });
  if (!operatorDecision.allowed) {
    return reject("OPERATOR_PROOF_" + operatorDecision.reasonCode);
  }

  // Compare the FULL operator statement (not only customer SQLite) to a
  // separately signed current witness. An old operator file plus old customer
  // copy passes the first check but MUST fail against a newer witness.
  const witnessDecision = verifyRestoreWitnessWithKeyLifecycle({
    restored: operatorProof.statement,
    statement: witnessProof.statement,
    signatureBase64: witnessProof.signatureBase64,
    keyring: witnessKeyring, trustedKeyringEpoch: witnessTrustedEpoch,
    trustedKeyringSha256Hex: witnessTrustedDigest,
    expectedNonce, nowMs,
  });
  if (!witnessDecision.allowed) {
    return reject("INDEPENDENT_WITNESS_" + witnessDecision.reasonCode);
  }
  const checkpointProblem = compareToTrustedCheckpoint(
    witnessProof.statement, trustedWitnessCheckpoint, witnessTrustedEpoch,
  );
  if (checkpointProblem) return reject(checkpointProblem);
  return Object.freeze({
    evidenceMatched: true,
    customerAuthorizationAllowed: false,
    reasonCode: "SYNTHETIC_SEPARATE_WITNESS_MATCH_ONLY",
  });
}
