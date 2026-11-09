import test from "node:test";
import assert from "node:assert/strict";

import { validateRemediation } from "./validate-credential-remediation.mjs";

const finding = {
  Fingerprint: "abc123",
  RuleID: "generic-api-key",
  File: "config/example.env",
  Commit: "0123456789abcdef",
};

function ledgerEntry(overrides = {}) {
  return {
    fingerprint: finding.Fingerprint,
    ruleId: finding.RuleID,
    path: finding.File,
    commit: finding.Commit,
    status: "ROTATED",
    ...overrides,
  };
}

test("empty report and empty versioned ledger pass", () => {
  assert.deepEqual(
    validateRemediation([], { version: 1, findings: [] }),
    { totalFindings: 0, remediatedFindings: 0 },
  );
});

test("every report fingerprint must have remediation", () => {
  assert.throws(
    () => validateRemediation([finding], { version: 1, findings: [] }),
    /UNREMEDIATED_SECRET_FINDING:abc123/,
  );
});

test("accepted remediation statuses pass", () => {
  for (const status of ["ROTATED", "REVOKED", "FALSE_POSITIVE_REVIEWED"]) {
    assert.deepEqual(
      validateRemediation([finding], {
        version: 1,
        findings: [ledgerEntry({ status })],
      }),
      { totalFindings: 1, remediatedFindings: 1 },
    );
  }
});

test("unknown remediation status fails closed", () => {
  assert.throws(
    () => validateRemediation([finding], {
      version: 1,
      findings: [ledgerEntry({ status: "IGNORED" })],
    }),
    /INVALID_REMEDIATION_STATUS:IGNORED/,
  );
});

test("duplicate remediation fingerprints are rejected", () => {
  assert.throws(
    () => validateRemediation([finding], {
      version: 1,
      findings: [ledgerEntry(), ledgerEntry()],
    }),
    /DUPLICATE_REMEDIATION_FINGERPRINT:abc123/,
  );
});

test("ledger metadata must match the redacted report", () => {
  assert.throws(
    () => validateRemediation([finding], {
      version: 1,
      findings: [ledgerEntry({ path: "wrong/path" })],
    }),
    /REMEDIATION_METADATA_MISMATCH:abc123:path/,
  );
});

test("ledger rejects fields capable of storing secret material", () => {
  for (const forbidden of [
    "secret",
    "value",
    "token",
    "password",
    "privateKey",
    "credentialValue",
  ]) {
    assert.throws(
      () => validateRemediation([finding], {
        version: 1,
        findings: [{ ...ledgerEntry(), [forbidden]: "redacted-or-not" }],
      }),
      new RegExp(`FORBIDDEN_REMEDIATION_FIELD:${forbidden}`),
    );
  }
});

test("ledger rejects nested forbidden fields", () => {
  assert.throws(
    () => validateRemediation([finding], {
      version: 1,
      findings: [{ ...ledgerEntry(), metadata: { token: "x" } }],
    }),
    /FORBIDDEN_REMEDIATION_FIELD:token/,
  );
});

test("malformed report fingerprints fail closed", () => {
  assert.throws(
    () => validateRemediation([{ ...finding, Fingerprint: "" }], {
      version: 1,
      findings: [],
    }),
    /INVALID_GITLEAKS_FINDING/,
  );
});
