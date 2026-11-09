import test from "node:test";
import assert from "node:assert/strict";
import { compareRestoredStateWithVerifiedAuthority as check } from "./customer-restore-authority-compare.mjs";

const binding = { customerId: "customer-a", installationId: "host-a", licenseId: "license-a", grantId: "grant-a", bindingEpoch: "epoch-a" };
const current = { ...binding, authorizationState: "ACTIVE", revocationGeneration: 4, migrationGeneration: 3, challengeConsumptionGeneration: 8, auditHighWater: 19, tokenGeneration: 2 };
const verified = { signatureValid: true, keyTrusted: true, nonceMatched: true, fresh: true, independentAuthority: true };
const evaluate = (restored=current, authority=current, verification=verified) => check({ restored, authority, verification });
const deny = (name, restored, authority, verification) => test(name, () => assert.equal(evaluate(restored, authority, verification).allowed, false));

test("matching verified authority passes comparison only", () => assert.deepEqual(evaluate(), { allowed: true, reasonCode: "RESTORE_COUNTERS_MATCH_VERIFIED_AUTHORITY" }));
for (const key of ["signatureValid", "keyTrusted", "nonceMatched", "fresh", "independentAuthority"]) {
  deny("missing/unverified "+key, current, current, { ...verified, [key]: false });
}
for (const key of ["customerId", "installationId", "licenseId", "grantId", "bindingEpoch"]) {
  deny("swapped binding "+key, { ...current, [key]: "attacker" }, current, verified);
}
for (const key of ["revocationGeneration", "migrationGeneration", "challengeConsumptionGeneration", "auditHighWater", "tokenGeneration"]) {
  deny("rollback "+key, { ...current, [key]: current[key] - 1 }, current, verified);
  deny("candidate ahead "+key, { ...current, [key]: current[key] + 1 }, current, verified);
  deny("invalid "+key, { ...current, [key]: -1 }, current, verified);
}
deny("revoked authority cannot authorize old ACTIVE snapshot", current, { ...current, authorizationState: "REVOKED" }, verified);
deny("restored revoked license cannot authorize", { ...current, authorizationState: "REVOKED" }, current, verified);
deny("missing restored state", null, current, verified);
deny("missing authority", current, null, verified);
deny("missing proof", current, current, null);
