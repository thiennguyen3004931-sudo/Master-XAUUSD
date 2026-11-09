/**
 * Strict restore-proof key lifecycle gate (P0 #176).
 *
 * The caller MUST supply an independently authenticated keyring AND a
 * separately durable trusted epoch (KMS/HSM/operator authority). Merely
 * putting both values in a restorable customer database defeats this gate.
 * No network, filesystem, secret-key access, customer activation or MT5 I/O.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { verifySignedRestoreAuthority, verifySignedRestoreWitness } from "./customer-restore-authority-signed-proof.mjs";

const deny = reasonCode => Object.freeze({ allowed: false, reasonCode });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const safeMs = value => Number.isSafeInteger(value) && value >= 0;
const exactKeys = (value, keys) =>
  object(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");

/**
 * Canonical keyring fingerprint. In production, the expected fingerprint MUST
 * come from an independently authenticated, durable operator/KMS trust root.
 * Never derive the trusted pin from an untrusted keyring during verification.
 */
export function fingerprintRestoreAuthorityKeyring(keyring) {
  try {
    if (!exactKeys(keyring, ["epoch", "keys"]) || !object(keyring.keys) ||
        !Number.isSafeInteger(keyring.epoch) || keyring.epoch < 1) return null;
    const ids = Object.keys(keyring.keys).sort();
    if (!ids.length || ids.length > 128) return null;
    const entries = [];
    for (const id of ids) {
      const e = keyring.keys[id];
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(id) ||
          !exactKeys(e, ["publicKeyPem", "status", "notBeforeMs", "notAfterMs"]) ||
          typeof e.publicKeyPem !== "string" || !e.publicKeyPem ||
          e.publicKeyPem.length > 8192 ||
          !safeMs(e.notBeforeMs) || !safeMs(e.notAfterMs) ||
          e.notAfterMs <= e.notBeforeMs ||
          (e.status !== "ACTIVE" && e.status !== "REVOKED")) return null;
      entries.push([id, e.publicKeyPem, e.status, e.notBeforeMs, e.notAfterMs]);
    }
    return createHash("sha256")
      .update("XAUUSD-RESTORE-KEYRING-V1\\n")
      .update(JSON.stringify([keyring.epoch, entries]))
      .digest("hex");
  } catch {
    return null;
  }
}

/**
 * Verifies a nonce-bound Ed25519 restore proof against a time-limited,
 * explicitly ACTIVE key and an independently pinned keyring epoch.
 *
 * A PASS is ONLY a cryptographic/counter comparison; it never authorizes
 * Gateway startup, trading, restore, customer release or live access.
 */
function verifyRestoreProofWithKeyLifecycle({
  restored, statement, signatureBase64, keyring,
  trustedKeyringEpoch, trustedKeyringSha256Hex, expectedNonce, nowMs,
} = {}, verifyProof) {
  try {
    if (!safeMs(nowMs) || !Number.isSafeInteger(trustedKeyringEpoch) ||
        trustedKeyringEpoch < 1) return deny("AUTHORITY_TRUST_ANCHOR_MISSING");
    if (!exactKeys(keyring, ["epoch", "keys"]) || !object(keyring.keys) ||
        !Number.isSafeInteger(keyring.epoch) || keyring.epoch < 1) {
      return deny("AUTHORITY_KEYRING_INVALID");
    }
    if (keyring.epoch < trustedKeyringEpoch) return deny("AUTHORITY_KEYRING_ROLLBACK");
    if (keyring.epoch > trustedKeyringEpoch) return deny("AUTHORITY_KEYRING_UNVERIFIED_EPOCH");
    const fingerprint = fingerprintRestoreAuthorityKeyring(keyring);
    if (!fingerprint) return deny("AUTHORITY_KEYRING_INVALID");
    if (typeof trustedKeyringSha256Hex !== "string" ||
        !/^[0-9a-f]{64}$/.test(trustedKeyringSha256Hex)) {
      return deny("AUTHORITY_TRUSTED_KEYRING_DIGEST_MISSING");
    }
    if (!timingSafeEqual(Buffer.from(fingerprint, "hex"),
                         Buffer.from(trustedKeyringSha256Hex, "hex"))) {
      return deny("AUTHORITY_KEYRING_DIGEST_MISMATCH");
    }
    if (!object(statement) || typeof statement.authorityKeyId !== "string" ||
        !/^[A-Za-z0-9._-]{1,128}$/.test(statement.authorityKeyId)) {
      return deny("AUTHORITY_SIGNER_ID_INVALID");
    }
    if (!Object.hasOwn(keyring.keys, statement.authorityKeyId)) {
      return deny("AUTHORITY_SIGNING_KEY_UNKNOWN");
    }
    const entry = keyring.keys[statement.authorityKeyId];
    if (!exactKeys(entry, ["publicKeyPem", "status", "notBeforeMs", "notAfterMs"]) ||
        typeof entry.publicKeyPem !== "string" || !entry.publicKeyPem ||
        entry.publicKeyPem.length > 8192 ||
        !safeMs(entry.notBeforeMs) || !safeMs(entry.notAfterMs) ||
        entry.notAfterMs <= entry.notBeforeMs ||
        (entry.status !== "ACTIVE" && entry.status !== "REVOKED")) {
      return deny("AUTHORITY_SIGNING_KEY_INVALID");
    }
    if (entry.status !== "ACTIVE") return deny("AUTHORITY_SIGNING_KEY_REVOKED");
    if (!safeMs(statement.issuedAt) || !safeMs(statement.expiresAt) ||
        statement.issuedAt < entry.notBeforeMs ||
        statement.expiresAt > entry.notAfterMs ||
        nowMs < entry.notBeforeMs || nowMs >= entry.notAfterMs) {
      return deny("AUTHORITY_SIGNING_KEY_OUTSIDE_VALIDITY");
    }
    // No untrusted fallback key, including on lookup or signature failure.
    const trustedPublicKeys = Object.create(null);
    trustedPublicKeys[statement.authorityKeyId] = entry.publicKeyPem;
    return verifyProof({
      restored, statement, signatureBase64, trustedPublicKeys,
      expectedNonce, nowMs,
    });
  } catch {
    return deny("AUTHORITY_KEYRING_UNAVAILABLE");
  }
}

/** Keep operator and witness purposes fixed; callers cannot choose the domain. */
export function verifyRestoreAuthorityWithKeyLifecycle(args = {}) {
  return verifyRestoreProofWithKeyLifecycle(args, verifySignedRestoreAuthority);
}

export function verifyRestoreWitnessWithKeyLifecycle(args = {}) {
  return verifyRestoreProofWithKeyLifecycle(args, verifySignedRestoreWitness);
}
