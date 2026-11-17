import { createPublicKey, verify as verifySignature } from "node:crypto";
import { compareRestoredStateWithVerifiedAuthority } from "./customer-restore-authority-compare.mjs";

const FIELDS = ["schemaVersion", "authorityKeyId", "issuedAt", "expiresAt", "requestNonce", "customerId", "installationId", "licenseId", "grantId", "bindingEpoch", "authorizationState", "revocationGeneration", "migrationGeneration", "challengeConsumptionGeneration", "auditHighWater", "tokenGeneration"];
const DOMAIN = "XAUUSD-CUSTOMER-RESTORE-AUTHORITY-V1\n";
const WITNESS_DOMAIN = "XAUUSD-CUSTOMER-RESTORE-WITNESS-V1\n";
const denied = (reasonCode) => Object.freeze({ allowed: false, reasonCode });
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const safeInt = (v) => Number.isSafeInteger(v) && v >= 0;

/** No I/O or runtime startup. Trusted keys and monotonicity MUST be independently administered. */
function verifySignedRestoreProof({ restored, statement, signatureBase64, trustedPublicKeys, expectedNonce, nowMs = Date.now() }, signatureDomain) {
  if (!isObject(statement) || !isObject(restored) || !isObject(trustedPublicKeys)) return denied("AUTHORITY_PROOF_MISSING");
  if (Object.keys(statement).sort().join("|") !== [...FIELDS].sort().join("|")) return denied("AUTHORITY_SCHEMA_INVALID");
  if (statement.schemaVersion !== 1 || typeof statement.authorityKeyId !== "string" || !statement.authorityKeyId ||
      typeof statement.requestNonce !== "string" || !statement.requestNonce ||
      typeof expectedNonce !== "string" || !expectedNonce || statement.requestNonce !== expectedNonce) return denied("AUTHORITY_NONCE_OR_VERSION_INVALID");
  if (!Number.isSafeInteger(nowMs) || !safeInt(statement.issuedAt) || !safeInt(statement.expiresAt) ||
      statement.issuedAt > nowMs || statement.expiresAt <= nowMs || statement.expiresAt <= statement.issuedAt ||
      statement.expiresAt - statement.issuedAt > 60_000) return denied("AUTHORITY_FRESHNESS_INVALID");
  for (const key of ["customerId", "installationId", "licenseId", "grantId", "bindingEpoch"]) {
    if (typeof statement[key] !== "string" || !statement[key]) return denied("AUTHORITY_BINDING_INVALID");
  }
  for (const key of ["revocationGeneration", "migrationGeneration", "challengeConsumptionGeneration", "auditHighWater", "tokenGeneration"]) {
    if (!safeInt(statement[key])) return denied("AUTHORITY_GENERATION_INVALID");
  }
  if (!["ACTIVE", "REVOKED", "EXPIRED"].includes(statement.authorizationState)) return denied("AUTHORITY_STATE_INVALID");
  const keyPem = Object.hasOwn(trustedPublicKeys, statement.authorityKeyId) ? trustedPublicKeys[statement.authorityKeyId] : null;
  if (typeof keyPem !== "string" || !keyPem || typeof signatureBase64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(signatureBase64)) return denied("AUTHORITY_KEY_OR_SIGNATURE_MISSING");
  try {
    const key = createPublicKey(keyPem);
    if (key.asymmetricKeyType !== "ed25519") return denied("AUTHORITY_KEY_TYPE_INVALID");
    const signature = Buffer.from(signatureBase64, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== signatureBase64) return denied("AUTHORITY_SIGNATURE_FORMAT_INVALID");
    const message = Buffer.from(signatureDomain + JSON.stringify(FIELDS.map((field) => statement[field])), "utf8");
    if (!verifySignature(null, message, key, signature)) return denied("AUTHORITY_SIGNATURE_INVALID");
  } catch {
    return denied("AUTHORITY_SIGNATURE_INVALID");
  }
  return compareRestoredStateWithVerifiedAuthority({
    restored,
    authority: statement,
    verification: { signatureValid: true, keyTrusted: true, nonceMatched: true, fresh: true, independentAuthority: true },
  });
}

export const RESTORE_AUTHORITY_SIGNING_FIELDS = Object.freeze([...FIELDS]);
export const RESTORE_AUTHORITY_SIGNING_DOMAIN = DOMAIN;

/** Fixed-purpose verifier; caller can never substitute the signature domain. */
export function verifySignedRestoreAuthority(args = {}) {
  return verifySignedRestoreProof(args, DOMAIN);
}

/** Witness attestations use a separate Ed25519 signing domain from operator authority. */
export function verifySignedRestoreWitness(args = {}) {
  return verifySignedRestoreProof(args, WITNESS_DOMAIN);
}

export const RESTORE_WITNESS_SIGNING_DOMAIN = WITNESS_DOMAIN;
