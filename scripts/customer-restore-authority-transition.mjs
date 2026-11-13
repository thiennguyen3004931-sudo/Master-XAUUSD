// Pure reference transition validator. NOT an independent durable authority or production store.
const KEYS = Object.freeze(["revocationGeneration", "migrationGeneration", "challengeConsumptionGeneration", "auditHighWater", "tokenGeneration"]);
const IDS = Object.freeze(["customerId", "installationId", "licenseId", "grantId", "bindingEpoch"]);
const deny = (reasonCode) => Object.freeze({ ok: false, reasonCode });
const valid = (value) => Number.isSafeInteger(value) && value >= 0;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Enforce atomic monotonic transition preconditions before any durable compare-and-swap. */
export function validateAuthorityTransition({ previous, next, expectedAuditHighWater }) {
  if (!object(previous) || !object(next)) return deny("AUTHORITY_STATE_MISSING");
  if (!valid(expectedAuditHighWater) || previous.auditHighWater !== expectedAuditHighWater) return deny("AUTHORITY_CAS_CONFLICT");
  for (const key of IDS) {
    if (typeof previous[key] !== "string" || !previous[key] || previous[key] !== next[key]) return deny("AUTHORITY_BINDING_CHANGED");
  }
  if (!["ACTIVE", "REVOKED", "EXPIRED"].includes(previous.authorizationState) ||
      !["ACTIVE", "REVOKED", "EXPIRED"].includes(next.authorizationState)) return deny("AUTHORITY_STATE_INVALID");
  if (previous.authorizationState !== "ACTIVE" && next.authorizationState === "ACTIVE") return deny("AUTHORITY_REACTIVATION_REQUIRES_NEW_EPOCH");
  for (const key of KEYS) {
    if (!valid(previous[key]) || !valid(next[key])) return deny("AUTHORITY_GENERATION_INVALID");
    if (next[key] < previous[key]) return deny("AUTHORITY_GENERATION_DECREASE");
  }
  if (next.auditHighWater !== previous.auditHighWater + 1) return deny("AUTHORITY_AUDIT_NOT_INCREMENTED");
  if (next.authorizationState !== previous.authorizationState && next.revocationGeneration <= previous.revocationGeneration) return deny("AUTHORITY_STATE_CHANGE_WITHOUT_REVOCATION_GENERATION");
  const changed = KEYS.some(key => next[key] !== previous[key]) || next.authorizationState !== previous.authorizationState;
  if (!changed) return deny("AUTHORITY_NOOP");
  return Object.freeze({ ok: true, reasonCode: "AUTHORITY_TRANSITION_VALID" });
}
