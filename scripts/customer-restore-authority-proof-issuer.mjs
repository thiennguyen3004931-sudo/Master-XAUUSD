// Pure proof-issuance reference. Production signing key must live in operator-controlled KMS/HSM.
import { createPrivateKey, sign } from "node:crypto";
import { RESTORE_AUTHORITY_SIGNING_FIELDS as FIELDS, RESTORE_AUTHORITY_SIGNING_DOMAIN as DOMAIN, RESTORE_WITNESS_SIGNING_DOMAIN as WITNESS_DOMAIN } from "./customer-restore-authority-signed-proof.mjs";
const safe = n => Number.isSafeInteger(n) && n >= 0;
const deny = reasonCode => Object.freeze({ ok:false, reasonCode });
/** Issue a short-lived proof from an already independently verified authority snapshot. */
function issueSignedRestoreProof({ authority, authorityKeyId, privateKeyPem, requestNonce, nowMs, ttlMs=30_000 }, signatureDomain) {
  if (!authority || typeof authority !== "object" || Array.isArray(authority) ||
      typeof authorityKeyId !== "string" || !authorityKeyId ||
      typeof privateKeyPem !== "string" || !privateKeyPem ||
      typeof requestNonce !== "string" || requestNonce.length < 16 || requestNonce.length > 256 ||
      !safe(nowMs) || !safe(ttlMs) || ttlMs < 1 || ttlMs > 60_000 || !safe(nowMs + ttlMs)) return deny("AUTHORITY_ISSUER_INPUT_INVALID");
  const statement = {schemaVersion:1,authorityKeyId,issuedAt:nowMs,expiresAt:nowMs+ttlMs,requestNonce};
  for (const key of ["customerId","installationId","licenseId","grantId","bindingEpoch"]) {
    if (typeof authority[key] !== "string" || !authority[key]) return deny("AUTHORITY_ISSUER_BINDING_INVALID");
    statement[key]=authority[key];
  }
  if (!["ACTIVE","REVOKED","EXPIRED"].includes(authority.authorizationState)) return deny("AUTHORITY_ISSUER_STATE_INVALID");
  statement.authorizationState=authority.authorizationState;
  for (const key of ["revocationGeneration","migrationGeneration","challengeConsumptionGeneration","auditHighWater","tokenGeneration"]) {
    if (!safe(authority[key])) return deny("AUTHORITY_ISSUER_COUNTER_INVALID");
    statement[key]=authority[key];
  }
  try {
    const key=createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return deny("AUTHORITY_ISSUER_KEY_TYPE_INVALID");
    const message=Buffer.from(signatureDomain+JSON.stringify(FIELDS.map(field=>statement[field])),"utf8");
    const signatureBase64=sign(null,message,key).toString("base64");
    return Object.freeze({ok:true,statement:Object.freeze(statement),signatureBase64});
  } catch { return deny("AUTHORITY_ISSUER_SIGNING_FAILED"); }
}

/** Operator restore statement: fixed authority signing purpose. */
export function issueRestoreAuthorityProof(args = {}) {
  return issueSignedRestoreProof(args, DOMAIN);
}

/** Separate witness statement: fixed independent high-water signing purpose. */
export function issueRestoreWitnessProof(args = {}) {
  return issueSignedRestoreProof(args, WITNESS_DOMAIN);
}
