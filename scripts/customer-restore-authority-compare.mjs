// Pure, dependency-free admission predicate. It does NOT authenticate signatures or fetch an authority.
// Caller MUST verify authority signature, key lifecycle, nonce, freshness and independent storage first.
const COUNTERS = Object.freeze([
  "revocationGeneration",
  "migrationGeneration",
  "challengeConsumptionGeneration",
  "auditHighWater",
  "tokenGeneration",
]);
const BINDING = Object.freeze(["customerId", "installationId", "licenseId", "grantId", "bindingEpoch"]);

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function blocked(reasonCode) {
  return Object.freeze({ allowed: false, reasonCode });
}

/**
 * Fail-closed comparison ONLY. Never pass a raw/unverified authority payload.
 * A PASS means the candidate may proceed to OTHER security gates, never activate a service.
 */
export function compareRestoredStateWithVerifiedAuthority({ restored, authority, verification }) {
  if (verification?.signatureValid !== true || verification?.keyTrusted !== true ||
      verification?.nonceMatched !== true || verification?.fresh !== true ||
      verification?.independentAuthority !== true) {
    return blocked("AUTHORITY_NOT_VERIFIED");
  }
  if (!restored || !authority || typeof restored !== "object" || typeof authority !== "object") {
    return blocked("RESTORE_STATE_MISSING");
  }
  for (const key of BINDING) {
    if (typeof restored[key] !== "string" || !restored[key] ||
        typeof authority[key] !== "string" || !authority[key] ||
        restored[key] !== authority[key]) {
      return blocked("RESTORE_BINDING_MISMATCH");
    }
  }
  for (const key of COUNTERS) {
    if (!integer(restored[key]) || !integer(authority[key])) {
      return blocked("RESTORE_GENERATION_INVALID");
    }
    if (restored[key] < authority[key]) {
      return blocked("RESTORE_GENERATION_ROLLBACK");
    }
    // A candidate ahead of independent durable authority is also inconsistent.
    if (restored[key] > authority[key]) {
      return blocked("RESTORE_GENERATION_AHEAD_OF_AUTHORITY");
    }
  }
  if (authority.authorizationState !== "ACTIVE" || restored.authorizationState !== "ACTIVE") {
    return blocked("RESTORE_NOT_ACTIVE");
  }
  return Object.freeze({ allowed: true, reasonCode: "RESTORE_COUNTERS_MATCH_VERIFIED_AUTHORITY" });
}
